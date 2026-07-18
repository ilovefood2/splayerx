
import { inAppPurchase, app } from 'electron';
import { remove } from 'lodash';
// @ts-ignore
import storage from '@splayer/electron-json-storage';
import { verifyReceipt } from '../../shared/utils';

type PaymentData = {
  transactionID: string,
  productID: string,
  receipt: string,
  currency: string,
  date: string,
}

type TransactionData = {
  date: string,
  payment: PaymentData,
}

interface IApplePayVerify {
  verifyAfterPay(transaction: TransactionData): Promise<boolean>,
  verifyAfterSignIn(): Promise<boolean>,
  verifyAfterOpenApp(): Promise<void>,
  setEndpoint(endpoint: string): void,
  isWaitingSignIn(): boolean,
}

class ApplePayVerify implements IApplePayVerify {
  private endpoint = '';

  private waitingTransaction?: TransactionData;

  private getListFromCache(): Promise<TransactionData[]> {
    return new Promise((resolve) => {
      storage.get('apple-receipt-cache', (err, data: {
        list: TransactionData[],
      }) => {
        if (data && data.list && data.list.length > 0) {
          resolve(data.list);
        } else {
          resolve([]);
        }
      });
    });
  }

  private setListCache(list: TransactionData[]): Promise<void> {
    return new Promise((resolve) => {
      try {
        // The storage API is callback-based. Waiting for that callback keeps
        // consecutive receipt removals from reading stale cache contents.
        storage.set('apple-receipt-cache', { list }, () => resolve());
      } catch (error) {
        // Receipt verification must still complete if local persistence fails.
        resolve();
      }
    });
  }

  private async addListToCache(transaction: TransactionData) {
    const list: TransactionData[] = await this.getListFromCache();
    list.push(transaction);
    await this.setListCache(list);
  }

  private async removeFromCache(transactionID: string) {
    const list: TransactionData[] = await this.getListFromCache();
    remove(list, (e: TransactionData) => e.payment.transactionID === transactionID);
    await this.setListCache(list);
  }

  public setEndpoint(endpoint: string) {
    this.endpoint = endpoint;
  }

  public isWaitingSignIn() {
    return !!this.waitingTransaction;
  }

  public async verifyAfterPay(transaction: TransactionData): Promise<boolean> {
    await this.addListToCache(transaction);
    try {
      const res = await verifyReceipt(this.endpoint, transaction.payment);
      await this.removeFromCache(transaction.payment.transactionID);
      inAppPurchase.finishTransactionByDate(transaction.date);
      if (res === 0) {
        return true;
      }
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        app.emit('sign-out');
        this.waitingTransaction = transaction;
        return false;
      }
    }
    throw new Error('verifyReceipt server error');
  }

  public async verifyAfterSignIn(): Promise<boolean> {
    const { waitingTransaction } = this;
    if (!waitingTransaction) return false;
    try {
      const res = await verifyReceipt(this.endpoint, waitingTransaction.payment);
      await this.removeFromCache(waitingTransaction.payment.transactionID);
      inAppPurchase.finishTransactionByDate(waitingTransaction.date);
      this.waitingTransaction = undefined;
      if (res === 0) {
        return true;
      }
    } catch (error) {
      // empty
    }
    throw new Error('verifyReceipt server error');
  }

  public async verifyAfterOpenApp() {
    let success = false;
    const list = await this.getListFromCache();
    // Sequential on purpose: every successful verification updates the same
    // cache file. Parallel read-modify-write operations can restore entries
    // that a sibling operation just removed.
    for (let i = 0; i < list.length; i += 1) {
      const transaction = list[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await verifyReceipt(this.endpoint, transaction.payment);
        // eslint-disable-next-line no-await-in-loop
        await this.removeFromCache(transaction.payment.transactionID);
        inAppPurchase.finishTransactionByDate(transaction.date);
        success = success || res === 0;
      } catch (error) {
        // empty
        if (error && (error.status === 401 || error.status === 403)) {
          app.emit('sign-out');
        }
      }
    }
    if (!success) {
      throw new Error('no verifyReceipt result');
    }
  }
}

export default ApplePayVerify;

export const applePayVerify = new ApplePayVerify();
