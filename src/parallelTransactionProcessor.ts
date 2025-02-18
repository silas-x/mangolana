import {
  Connection,
  Keypair,
  RpcResponseAndContext,
  SignatureStatus,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { chunks, getUnixTs, MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION } from './tools';
import { TransactionInstructionWithSigners, WalletSigner } from './globalTypes';

export class _TransactionInstructionWithIndex extends TransactionInstructionWithSigners {
  index: number;
  constructor(transactionInstruction: TransactionInstruction, signers: Keypair[] = [], index: number) {
    super(transactionInstruction, signers);
    this.index = index;
  }
}

export type _SendedTransactionWithTimestamp = {
  id: string;
  timestamp: number;
  index: number;
  sendedAtBlock: number;
};

export type _SendedTransactionWithIndex = {
  id: string;
  index: number;
};

const timeoutSecs = 90;

const sendTransactionChunk = async (
  transactionInstructions: _TransactionInstructionWithIndex[],
  wallet: WalletSigner,
  connection: Connection,
): Promise<_SendedTransactionWithTimestamp[]> => {
  const block = await connection.getLatestBlockhash('confirmed');
  const toSignQueued: Transaction[] = [...transactionInstructions].map((tiws) => {
    const transaction = new Transaction({ feePayer: wallet.publicKey });
    transaction.add(tiws.transactionInstruction);
    transaction.recentBlockhash = block.blockhash;
    if (tiws.signers.length > 0) {
      transaction.partialSign(...tiws.signers);
    }
    return transaction;
  });
  const signedTxns: Transaction[] = await wallet.signAllTransactions(toSignQueued);
  const sendedTransactionsSignatures = await Promise.all(
    signedTxns.map((x) => {
      const rawTransaction = x.serialize();
      return connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
    }),
  );
  return [
    //return transactions marked with index of instruction, block and timestamp
    ...sendedTransactionsSignatures.map((x, idx) => {
      const nowTimestamp = getUnixTs();
      return {
        id: x,
        timestamp: nowTimestamp,
        index: transactionInstructions[idx].index,
        sendedAtBlock: block.lastValidBlockHeight,
      };
    }),
  ];
};

const sendInstructions = async (
  transactionsWithIndex: _TransactionInstructionWithIndex[],
  batchSize: number,
  wallet: WalletSigner,
  connection: Connection,
) => {
  const toConfirm: _SendedTransactionWithTimestamp[] = [];
  const transactionsChunks = chunks(transactionsWithIndex, batchSize);
  for (let i = 0; i < transactionsChunks.length; i++) {
    const sendedTransactions = await sendTransactionChunk(transactionsChunks[i], wallet, connection);
    toConfirm.push(...sendedTransactions);
  }
  return toConfirm;
};

export type parallelTransactionProcessorProps = {
  transactionInstructionsWithSigners: TransactionInstructionWithSigners[];
  connection: Connection;
  wallet: WalletSigner;
  batchSize?: number;
  maxRetryNumber?: number;
};
/**
 * sign, send and wait for confirmation of parallel transactions, best for in code keypair wallet
 */
export const parallelTransactionProcessor = async ({
  transactionInstructionsWithSigners,
  connection,
  wallet,
  batchSize = 50,
  maxRetryNumber = 5,
}: parallelTransactionProcessorProps) => {
  //interval checking if transactions are confirmed in ms
  const confirmationIntervalPeriod = 5000;
  //If interval run x times and array is empty x times then processor is resolving promise.
  const toConfirmIsEmptyCheckEndThreshold = 5;
  //current retry count
  let retryCount = 0;
  //how many times toConfirmArray was empty
  let toConfirmIsEmptyCount = 0;
  //after defaultTimeout it will start to check blockchain block
  let startBlockCheck = false;

  //mark transactions with instruction index
  const txWithIdx: _TransactionInstructionWithIndex[] = transactionInstructionsWithSigners.map((x, idx) => {
    return {
      ...x,
      index: idx,
    };
  });
  const toConfirm: _SendedTransactionWithTimestamp[] = [];
  const notConfirmed: _SendedTransactionWithIndex[] = [];

  //send transactions in batches
  const sendedTransactions = await sendInstructions(txWithIdx, batchSize, wallet, connection);
  toConfirm.push(...sendedTransactions);

  const done = await new Promise((resolve) => {
    const maxConfirmBatchSize = 256;

    const confirmationInterval = setInterval(async () => {
      if (!toConfirm.length) {
        toConfirmIsEmptyCount += 1;
      } else {
        toConfirmIsEmptyCount = 0;
      }
      console.log({
        notConfirmed: notConfirmed.length,
        toConfirm: toConfirm.length,
      });
      if (toConfirmIsEmptyCount === toConfirmIsEmptyCheckEndThreshold) {
        if (!notConfirmed.length || retryCount >= maxRetryNumber) {
          resolve('done');
          clearInterval(confirmationInterval);
        } else {
          const instructionsToRetry = notConfirmed.map((x) => {
            return {
              ...transactionInstructionsWithSigners[x.index],
              index: x.index,
            };
          });
          const sendedTransactions = await sendInstructions(instructionsToRetry, batchSize, wallet, connection);
          retryCount += 1;
          startBlockCheck = false;
          //clear array of not confirmed
          notConfirmed.splice(0, notConfirmed.length);
          toConfirm.push(...sendedTransactions);
        }
      }

      const statusChecks: [
        Promise<RpcResponseAndContext<(SignatureStatus | null)[]>>,
        Promise<{
          blockhash: string;
          lastValidBlockHeight: number;
        }>?,
      ] = [connection.getSignatureStatuses([...toConfirm.slice(0, maxConfirmBatchSize).map((x) => x.id)])];
      if (startBlockCheck) {
        statusChecks.push(connection.getLatestBlockhash('processed'));
      }
      //checking signatures + after timeoutPeriod we start checking current block
      const [signatures, block] = await Promise.all(statusChecks);
      for (let i = 0; i < signatures?.value?.length; i++) {
        const signature = signatures.value[i];

        if (signature?.confirmationStatus === 'confirmed') {
          //remove item from que
          toConfirm.splice(i, 1);
        } else {
          const nowTimestamp = getUnixTs();
          if (nowTimestamp - toConfirm[i].timestamp >= timeoutSecs) {
            startBlockCheck = true;
            console.log(
              block && block.lastValidBlockHeight,
              toConfirm[i].sendedAtBlock + MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION,
            );
            if (
              block &&
              block.lastValidBlockHeight >= toConfirm[i].sendedAtBlock + MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION
            ) {
              notConfirmed.push({
                id: toConfirm[i].id,
                index: toConfirm[i].index,
              });
              //remove item from que
              toConfirm.splice(i, 1);
            }
          }
        }
      }
    }, confirmationIntervalPeriod);
  });
  return done;
};
