import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseTransaction } from '../src/sorter/parsers.js';

describe('parseTransaction', () => {

  test('Mox card transaction', () => {
    const result = parseTransaction(
      'notify@mox.com',
      'Mox Card交易成功',
      'Mox Card交易成功 你已在SUPERMART消費HKD350.00！如懷疑電28888228',
      '2026-03-07T10:11:47Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-03-07',
      merchant: 'SUPERMART',
      amount: 350.00,
      currency: 'HKD',
      source: 'Mox',
      type: 'payment'
    });
  });

  test('Mox USD transaction with miles', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '交易已完成並可賺取里數！🤩',
      '交易已完成並可賺取里數！🤩 你已在Domainly消費USD11.48，可獲11.23里數！如懷疑電28888228',
      '2026-03-07T04:43:24Z'
    );
    assert.strictEqual(result.merchant, 'Domainly');
    assert.strictEqual(result.amount, 11.48);
    assert.strictEqual(result.currency, 'USD');
  });

  test('Ant Bank PayLater', () => {
    const body = 'Ant Bank PayLater - PayLater Payment Successful\nDear Valued Customer,\nThank you for choosing Ant Bank PayLater! Your payment of HK$59.00 has been made according to your instruction.\nAmount spent (HKD)\n59.00';
    const result = parseTransaction(
      'hk_antbank_service@notify.antbank.hk',
      'PayLater 付款成功',
      body,
      '2026-03-07T02:50:36Z'
    );
    assert.strictEqual(result.amount, 59.00);
    assert.strictEqual(result.currency, 'HKD');
    assert.strictEqual(result.source, 'Ant Bank');
  });

  test('HSBC payment transfer', () => {
    const body = '您已於 2026-03-07 10:50 透過滙豐網上或流動理財將 HKD15,000.00 轉往 DAH SING BANK 。';
    const result = parseTransaction(
      'HSBC@notification.hsbc.com.hk',
      '支付通知 Ref:[D0000000001]',
      body,
      '2026-03-07T10:50:06Z'
    );
    assert.strictEqual(result.amount, 15000.00);
    assert.strictEqual(result.merchant, 'DAH SING BANK');
    assert.strictEqual(result.source, 'HSBC');
    assert.strictEqual(result.type, 'transfer');
  });

  test('PayPal receipt', () => {
    const body = '你已支付 $11.48 USD 給 Domainly, Inc\n交易 ID\n9XP00000A0000000P';
    const result = parseTransaction(
      'service@paypal.com.hk',
      '你付款給 Domainly, Inc 的收據',
      body,
      '2026-03-07T04:43:56Z'
    );
    assert.strictEqual(result.amount, 11.48);
    assert.strictEqual(result.currency, 'USD');
    assert.strictEqual(result.merchant, 'Domainly, Inc');
    assert.strictEqual(result.source, 'PayPal');
  });

  test('HKeToll toll', () => {
    const body = '易通行：AB1234於06/03/2026, 20:03 駛經紅磡海底隧道(往九龍)，隧道費為HK$20.00。';
    const result = parseTransaction(
      'do-not-reply2@hketoll.gov.hk',
      '易通行交易通知',
      body,
      '2026-03-06T20:06:43Z'
    );
    assert.strictEqual(result.amount, 20.00);
    assert.strictEqual(result.merchant, '紅磡海底隧道(往九龍)');
    assert.strictEqual(result.source, 'HKeToll');
    assert.strictEqual(result.type, 'toll');
  });

  test('Dah Sing bill payment', () => {
    const body = '商戶名稱：匯豐信用卡 \n賬單類別：不適用\n賬單號碼：4000001234***890\n賬單簡稱：4000001234567890\n繳費金額：港元 15,000.00\n提款賬戶：大新 World 萬事達卡 （尾數 1234 ）';
    const result = parseTransaction(
      'ebanking@dahsing.com',
      '已執行繳費交易',
      body,
      '2026-03-06T10:28:11Z'
    );
    assert.strictEqual(result.amount, 15000.00);
    assert.strictEqual(result.merchant, '匯豐信用卡');
    assert.strictEqual(result.source, 'Dah Sing');
  });

  test('McDonald\'s order', () => {
    const body = '餐廳名稱：\nGRAND PLAZA\n數量\n產品名稱\n單價\n1\n豬柳漢堡™套餐\nHKD35.00\n總計：\nHKD39.00\n支付方式:\n授權金額：\nHKD39.00';
    const result = parseTransaction(
      'DoNotReply@mcdonalds.com',
      '麥當勞® - 手機訂單確認',
      body,
      '2026-03-06T09:45:45Z'
    );
    assert.strictEqual(result.amount, 39.00);
    assert.strictEqual(result.merchant, "McDonald's");
    assert.strictEqual(result.source, "McDonald's");
  });

  test('returns null for unparseable body', () => {
    const result = parseTransaction(
      'unknown@example.com',
      'Hello',
      'No transaction info here',
      '2026-03-07T00:00:00Z'
    );
    assert.strictEqual(result, null);
  });
});
