import {
  Commitment,
  Connection,
  Keypair,
  RpcResponseAndContext,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
} from '@solana/web3.js';
import bs58 = require('bs58');
import { getUnixTs, MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION, sleep } from './tools';
import {
  BlockHeightStrategy,
  BlockHeightStrategyClass,
  getTimeoutConfig,
  isBlockHeightStrategy,
  SequenceType,
  TimeStrategy,
  TimeStrategyClass,
  TransactionInstructionWithSigners,
  WalletSigner,
} from './globalTypes';

export interface TransactionInstructionWithType {
  instructionsSet: TransactionInstructionWithSigners[];
  sequenceType?: SequenceType;
}

export interface TransactionsPlayingIndexes {
  transactionsIdx: { [txIdx: number]: number }[];
  sequenceType?: SequenceType;
}

export type awaitTransactionSignatureConfirmationProps = {
  txid: TransactionSignature;
  confirmLevel: TransactionConfirmationStatus;
  connection: Connection;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
};
/**
 * waits for transaction confirmation
 * @param timeoutStrategy TimeStrategy | BlockHeightStrategy
 *
 * TimeStrategy: pure timeout strategy
 *
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 2000
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 *
 */
export const awaitTransactionSignatureConfirmation = async ({
  txid,
  confirmLevel,
  connection,
  timeoutStrategy,
}: awaitTransactionSignatureConfirmationProps) => {
  const timeoutConfig = getTimeoutConfig(timeoutStrategy);
  let timeoutBlockHeight = 0;
  let timeout = 0;
  if (timeoutConfig instanceof BlockHeightStrategyClass) {
    timeoutBlockHeight = timeoutConfig.block.lastValidBlockHeight + MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION;
    timeout = timeoutConfig.startBlockCheckAfterSecs;
  } else {
    timeout = timeoutConfig.timeout;
  }

  let startTimeoutCheck = false;
  let done = false;
  const confirmLevels: (TransactionConfirmationStatus | null | undefined)[] = ['finalized'];
  if (confirmLevel === 'confirmed') {
    confirmLevels.push('confirmed');
  } else if (confirmLevel === 'processed') {
    confirmLevels.push('confirmed');
    confirmLevels.push('processed');
  }
  let subscriptionId: number | undefined;

  const result = await new Promise((resolve, reject) => {
    (async () => {
      setTimeout(() => {
        if (done) {
          return;
        }
        if (timeoutBlockHeight !== 0) {
          startTimeoutCheck = true;
        } else {
          done = true;
          console.log('Timed out for txid: ', txid);
          reject({ timeout: true });
        }
      }, timeout);
      try {
        subscriptionId = connection.onSignature(
          txid,
          (result, context) => {
            subscriptionId = undefined;
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          'processed',
        );
      } catch (e) {
        done = true;
        console.log('WS error in setup', txid, e);
      }
      const retrySleep = timeoutConfig.getSignatureStatusesPoolIntervalMs || 5000;
      while (!done) {
        // eslint-disable-next-line no-loop-func
        await sleep(retrySleep);
        (async () => {
          try {
            const promises: [Promise<RpcResponseAndContext<(SignatureStatus | null)[]>>, Promise<number>?] = [
              connection.getSignatureStatuses([txid]),
            ];
            //if startTimeoutThreshold passed we start to check if
            //current blocks are did not passed timeoutBlockHeight threshold
            if (startTimeoutCheck) {
              promises.push(connection.getBlockHeight('confirmed'));
            }
            const [signatureStatuses, currentBlockHeight] = await Promise.all(promises);
            if (typeof currentBlockHeight !== undefined && timeoutBlockHeight <= currentBlockHeight!) {
              console.log('Timed out for txid: ', txid);
              done = true;
              reject({ timeout: true });
            }

            const result = signatureStatuses && signatureStatuses.value[0];
            if (!done) {
              if (!result) return;
              if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              } else if (!(result.confirmations || confirmLevels.includes(result.confirmationStatus))) {
                console.log('REST not confirmed', txid, result);
              } else {
                console.log('REST confirmed', txid, result);
                done = true;
                resolve(result);
              }
            }
          } catch (e) {
            if (!done) {
              console.log('REST connection error: txid', txid, e);
            }
          }
        })();
      }
    })();
  });

  if (subscriptionId) {
    connection.removeSignatureListener(subscriptionId).catch((e) => {
      console.log('WS error in cleanup', e);
    });
  }

  done = true;
  return result;
};

export type sendAndConfirmSignedTransactionProps = {
  signedTransaction: Transaction;
  connection: Connection;
  confirmLevel?: TransactionConfirmationStatus;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
  callbacks?: {
    postSendTxCallback?: ({ txid }: { txid: string }) => void;
    afterTxConfirmation?: () => void;
  };
  config?: {
    resendTxUntilConfirmed?: boolean;
    resendPoolTimeMs?: number;
  };
};

/**
 * send and waits for transaction to confirm
 * @param callbacks sets of callbacks.
 * @param callbacks.postSendTxCallback post send transaction callback
 * @param callbacks.afterTxConfirmation runs after tx confirmation
 * @param timeoutStrategy TimeStrategy | BlockHeightStrategy
 *
 * TimeStrategy: pure timeout strategy
 *
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 5000
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 *
 * @param config.resendTxUntilConfirmed force resend transaction in the mean time of waiting for confirmation, default false
 * @param config.resendPoolTimeMs when resendTxUntilConfirmed is true it will resend transaction every value of ms until there is timeout, default 2000
 */
export const sendAndConfirmSignedTransaction = async ({
  signedTransaction,
  confirmLevel = 'processed',
  connection,
  callbacks,
  timeoutStrategy,
  config,
}: sendAndConfirmSignedTransactionProps) => {
  const timeoutConfig = getTimeoutConfig(timeoutStrategy);
  let resendTimeout = 0;
  if (timeoutConfig instanceof BlockHeightStrategyClass) {
    resendTimeout = timeoutConfig.startBlockCheckAfterSecs;
  } else {
    resendTimeout = timeoutConfig.timeout;
  }

  const rawTransaction = signedTransaction.serialize();
  let txid = bs58.encode(signedTransaction.signatures[0].signature!);
  const startTime = getUnixTs();
  txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
  });
  console.log(txid);
  if (callbacks?.postSendTxCallback) {
    try {
      callbacks.postSendTxCallback({ txid });
    } catch (e) {
      console.log(`postSendTxCallback error ${e}`);
    }
  }

  let done = false;
  if (config?.resendTxUntilConfirmed) {
    (async () => {
      while (!done && getUnixTs() - startTime < resendTimeout!) {
        await sleep(config?.resendPoolTimeMs || 2000);
        connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
      }
    })();
  }

  try {
    await awaitTransactionSignatureConfirmation({
      txid,
      timeoutStrategy: timeoutStrategy,
      confirmLevel,
      connection,
    });
    if (callbacks?.afterTxConfirmation) {
      callbacks.afterTxConfirmation();
    }
  } catch (err: any) {
    if (err.timeout) {
      throw { txid };
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (await simulateTransaction(connection, signedTransaction, 'single')).value;
    } catch (e) {
      console.log('Simulate tx failed');
    }
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw {
              message: 'Transaction failed: ' + line.slice('Program log: '.length),
              txid,
            };
          }
        }
      }
      throw {
        message: JSON.stringify(simulateResult.err),
        txid,
      };
    }
    throw { message: 'Transaction failed', txid };
  } finally {
    done = true;
  }
  return txid;
};

export type sendSignAndConfirmTransactionsProps = {
  connection: Connection;
  wallet: WalletSigner;
  transactionInstructions: TransactionInstructionWithType[];
  timeoutStrategy?: BlockHeightStrategy;
  callbacks?: {
    afterFirstBatchSign?: (signedTxnsCount: number) => void;
    afterBatchSign?: (signedTxnsCount: number) => void;
    afterAllTxConfirmed?: () => void;
    afterEveryTxConfirmation?: () => void;
    onError?: (
      e: any,
      notProcessedTransactions: TransactionInstructionWithType[],
      originalProps: sendSignAndConfirmTransactionsProps,
    ) => void;
  };
  config?: {
    maxTxesInBatch: number;
    autoRetry: boolean;
    maxRetries?: number;
    retried?: number;
  };
};
/**
 * sign and send array of transactions in desired batches with different styles of send for each array
 * @param timeoutStrategy
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 *
 *
 * @param callbacks sets of callbacks
 * @param callbacks.afterFirstBatchSign callback will run only on first batch approval
 * @param callbacks.afterBatchSign callback will run on any batch approval
 * @param callbacks.afterAllTxConfirmed callback will run after all transaction batches are confirmed
 * @param callbacks.afterEveryTxConfirmation callback will run on every single transaction confirmation
 * @param callbacks.onError callback will run on error
 *
 * @param config.maxTxesInBatch max transactions in one batch of transactions, there is limitation on how much wallet can sign in one go depending on used wallet. default 40
 * @param config.autoRetry auto retry on any error approve and send of transaction after error
 * @param config.maxRetries if auto retry is true, it will try this amount of times before actual error, default 5
 * @param config.retired argument passed by recursive function best not to change it, default 0
 */
export const sendSignAndConfirmTransactions = async ({
  connection,
  wallet,
  transactionInstructions,
  timeoutStrategy,
  callbacks,
  config = {
    maxTxesInBatch: 40,
    autoRetry: false,
    maxRetries: 5,
    retried: 0,
  },
}: sendSignAndConfirmTransactionsProps) => {
  let block = timeoutStrategy?.block;
  if (!wallet.publicKey) throw new Error('Wallet not connected!');
  if (!block) {
    block = await connection.getLatestBlockhash('confirmed');
  }
  if (typeof config?.retried === 'undefined') {
    config.retried = 0;
  }
  if (typeof config?.maxRetries === 'undefined') {
    config.maxRetries = 5;
  }
  //block will be used for timeout calculation
  //max usable transactions per one sign is 40
  const maxTransactionsInBath = config.maxTxesInBatch;
  const currentTransactions = transactionInstructions.slice(0, maxTransactionsInBath);
  const unsignedTxns: Transaction[] = [];
  //this object will determine how we run transactions e.g [ParallelTx, SequenceTx, ParallelTx]
  const transactionCallOrchestrator: TransactionsPlayingIndexes[] = [];
  for (let i = 0; i < currentTransactions.length; i++) {
    const transactionInstruction = currentTransactions[i];
    const signers: Keypair[] = [];
    if (transactionInstruction.instructionsSet.length === 0) {
      continue;
    }

    const transaction = new Transaction({ feePayer: wallet.publicKey });
    transactionInstruction.instructionsSet.forEach((instruction) => {
      transaction.add(instruction.transactionInstruction);
      if (instruction.signers.length) {
        signers.push(...instruction.signers);
      }
    });
    transaction.recentBlockhash = block.blockhash;
    if (signers.length) {
      transaction.partialSign(...signers);
    }
    //we take last index of unsignedTransactions to have right indexes because
    //if transactions was empty
    //then unsigned transactions could not mach TransactionInstructions param indexes
    const currentUnsignedTxIdx = unsignedTxns.length;
    const currentTransactionCall = transactionCallOrchestrator[transactionCallOrchestrator.length - 1];
    //we check if last item in current transactions call type is same
    //if not then we create next transaction type
    if (currentTransactionCall && currentTransactionCall.sequenceType === transactionInstruction.sequenceType) {
      //we push reflection of transactionInstruction as object value for retry.
      currentTransactionCall.transactionsIdx.push({
        [currentUnsignedTxIdx]: i,
      });
    } else {
      transactionCallOrchestrator.push({
        //we push reflection of transactionInstruction as object value for retry.
        transactionsIdx: [{ [currentUnsignedTxIdx]: i }],
        sequenceType: transactionInstruction.sequenceType,
      });
    }
    unsignedTxns.push(transaction);
  }
  console.log(transactionCallOrchestrator);
  const signedTxns = await wallet.signAllTransactions(unsignedTxns);
  if (callbacks?.afterFirstBatchSign) {
    callbacks.afterFirstBatchSign(signedTxns.length);
  } else if (callbacks?.afterBatchSign) {
    callbacks.afterBatchSign(signedTxns.length);
  }
  console.log(
    'Transactions play type order',
    transactionCallOrchestrator.map((x) => {
      return {
        ...x,
        sequenceType: typeof x.sequenceType !== 'undefined' ? SequenceType[Number(x.sequenceType)] : 'Parallel',
      };
    }),
  );
  console.log('Signed transactions', signedTxns);
  try {
    for (const fcn of transactionCallOrchestrator) {
      if (typeof fcn.sequenceType === 'undefined' || fcn.sequenceType === SequenceType.Parallel) {
        //wait for all Parallel
        await Promise.all(
          fcn.transactionsIdx.map((idx) => {
            const transactionIdx = Number(Object.keys(idx)[0]);
            const transactionInstructionIdx = idx[transactionIdx];
            return new Promise(async (resolve, reject) => {
              try {
                const resp = await sendAndConfirmSignedTransaction({
                  connection,
                  signedTransaction: signedTxns[transactionIdx],
                  timeoutStrategy: {
                    block: block!,
                  },
                  callbacks: {
                    afterTxConfirmation: callbacks?.afterEveryTxConfirmation,
                  },
                });
                resolve(resp);
              } catch (e) {
                console.log(e);
                if (typeof e === 'object') {
                  reject({
                    ...e,
                    transactionInstructionIdx,
                  });
                } else {
                  reject(e);
                }
              }
            });
          }),
        );
      }
      if (fcn.sequenceType === SequenceType.Sequential) {
        //wait for all Sequential
        for (const idx of fcn.transactionsIdx) {
          const transactionIdx = Number(Object.keys(idx)[0]);
          const transactionInstructionIdx = idx[transactionIdx];
          try {
            await sendAndConfirmSignedTransaction({
              connection,
              signedTransaction: signedTxns[transactionIdx],
              timeoutStrategy: {
                block,
              },
              callbacks: {
                afterTxConfirmation: callbacks?.afterEveryTxConfirmation,
              },
            });
          } catch (e) {
            console.log(e);
            if (typeof e === 'object') {
              throw {
                ...e,
                transactionInstructionIdx,
              };
            } else {
              throw e;
            }
          }
        }
      }
    }
    //we call recursively our function to forward rest of transactions if
    // number of them is higher then maxTransactionsInBath
    if (transactionInstructions.length > maxTransactionsInBath) {
      const forwardedTransactions = transactionInstructions.slice(
        maxTransactionsInBath,
        transactionInstructions.length,
      );
      await sendSignAndConfirmTransactions({
        connection,
        wallet,
        transactionInstructions: forwardedTransactions,
        timeoutStrategy: timeoutStrategy,
        callbacks: {
          afterBatchSign: callbacks?.afterBatchSign,
          afterAllTxConfirmed: callbacks?.afterAllTxConfirmed,
          afterEveryTxConfirmation: callbacks?.afterEveryTxConfirmation,
          onError: callbacks?.onError,
        },
      });
    }
    if (callbacks?.afterAllTxConfirmed) {
      callbacks.afterAllTxConfirmed();
    }
  } catch (e) {
    console.log(e);
    if (callbacks?.onError) {
      if (typeof e === 'object') {
        const idx = (e as any).txInstructionIdx;
        const txInstructionForRetry = transactionInstructions.slice(idx, transactionInstructions.length);
        callbacks.onError(e, txInstructionForRetry, {
          connection,
          wallet,
          transactionInstructions,
          timeoutStrategy,
          callbacks,
          config,
        });
      } else {
        callbacks.onError(e, [], {
          connection,
          wallet,
          transactionInstructions,
          timeoutStrategy,
          callbacks,
          config,
        });
      }
    }
    if (config.autoRetry && config.maxRetries < config.retried) {
      const idx = (e as any)?.txInstructionIdx;
      if (typeof idx !== 'undefined') {
        config.retried++;
        const txInstructionForRetry = transactionInstructions.slice(idx, transactionInstructions.length);
        await sendSignAndConfirmTransactions({
          connection,
          wallet,
          transactionInstructions: txInstructionForRetry,
          callbacks,
          config,
        });
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
};

/** Copy of Connection.simulateTransaction that takes a commitment parameter. */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching,
  );

  console.log('simulating transaction', transaction);

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');

  console.log('encoding');
  const config: any = { encoding: 'base64', commitment };
  const args = [encodedTransaction, config];
  console.log('simulating data', args);

  // @ts-ignore
  const res = await connection._rpcRequest('simulateTransaction', args);

  console.log('res simulating transaction', res);
  if (res.error) {
    throw new Error('failed to simulate transaction: ' + res.error.message);
  }
  return res.result;
}
