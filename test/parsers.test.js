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

  test('Dah Sing Card-Not-Present', () => {
    const body = 'Merchant: POWER GYMTransaction Amount:HKD 520.00Card No. ending with: 1234Transaction Date: 01 Mar 2026';
    const result = parseTransaction(
      'ebanking@dahsing.com',
      'Dah Sing Bank: Card-Not-Present Successful Transaction Alert',
      body,
      '2026-03-01T14:36:00Z'
    );
    assert.strictEqual(result.amount, 520.00);
    assert.strictEqual(result.currency, 'HKD');
    assert.strictEqual(result.merchant, 'POWER GYM');
    assert.strictEqual(result.source, 'Dah Sing');
  });

  test('Ant Bank 支付成功', () => {
    const body = 'Payment Successful Dear Valued Customer, We have debited HKD38.00 on 24/02 09:53 from your Libra Savings account';
    const result = parseTransaction(
      'hk_antbank_service@notify.antbank.hk',
      '支付成功',
      body,
      '2026-02-24T09:53:00Z'
    );
    assert.strictEqual(result.amount, 38.00);
    assert.strictEqual(result.currency, 'HKD');
    assert.strictEqual(result.source, 'Ant Bank');
    assert.strictEqual(result.type, 'payment');
  });

  test('PayPal 訂購', () => {
    const body = '你已向 GLOBALTEL COMMUNICATION... (info@globaltel-hk.example) 訂購 $12.00 USD';
    const result = parseTransaction(
      'service@paypal.com.hk',
      '你已提交向 GLOBALTEL 提交金額為 $12.00 USD 的訂單',
      body,
      '2026-02-23T18:43:10Z'
    );
    assert.strictEqual(result.amount, 12.00);
    assert.strictEqual(result.currency, 'USD');
    assert.strictEqual(result.merchant, 'GLOBALTEL COMMUNICATION...');
    assert.strictEqual(result.source, 'PayPal');
  });

  test('Stripe/Nimbus AI receipt', () => {
    const body = 'Receipt from Nimbus AI, Inc [#1111-2222] Amount paid $10.80 Date paid Mar 1, 2026';
    const result = parseTransaction(
      'receipts+acct_2BCDEFGHIJKLMNOP@stripe.com',
      'Your Nimbus AI, Inc receipt [#1111-2222]',
      body,
      '2026-03-01T02:03:44Z'
    );
    assert.strictEqual(result.amount, 10.80);
    assert.strictEqual(result.currency, 'USD');
    assert.strictEqual(result.merchant, 'Nimbus AI, Inc');
  });

  test('Stripe/Gridform receipt', () => {
    const body = 'Receipt from Gridform [#3333-4444] Amount paid $10.00 Date paid Feb 13, 2026';
    const result = parseTransaction(
      'receipts+acct_1ABCDEFGHIJKLMNO@stripe.com',
      'Your Gridform receipt [#3333-4444]',
      body,
      '2026-02-13T05:04:13Z'
    );
    assert.strictEqual(result.amount, 10.00);
    assert.strictEqual(result.merchant, 'Gridform');
  });

  test('Stripe/Vaultline receipt', () => {
    const body = 'Receipt from Vaultline c/o Meridian Apps Inc. [#5555-6666] Amount paid $5.99 Date paid Feb 13, 2026';
    const result = parseTransaction(
      'receipts+acct_3CDEFGHIJKLMNOPQ@stripe.com',
      'Your Vaultline receipt',
      body,
      '2026-02-13T04:55:07Z'
    );
    assert.strictEqual(result.amount, 5.99);
    assert.strictEqual(result.merchant, 'Vaultline c/o Meridian Apps Inc.');
  });

  test('fal.ai balance topup', () => {
    const result = parseTransaction(
      'billing@fal.ai',
      'Payment Confirmation',
      'Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance.',
      '2026-07-13T02:30:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-07-13',
      merchant: 'fal.ai',
      amount: 10.00,
      currency: 'USD',
      source: 'fal.ai',
      type: 'topup'
    });
  });

  test('fal.ai with zero-width wall (end-to-end via htmlToText)', async () => {
    const { htmlToText } = await import('../src/sorter/html-text.js');
    // Simulate real email structure: ZW literal wall + entity-encoded wall + real content
    const zwLiterals = '​‌‍'.repeat(50);
    const zwEntities = '&#65279;'.repeat(40) + '&#x200B;'.repeat(30);
    const htmlBody = '<div>' + zwLiterals + zwEntities +
      'Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance. Dashboard</div>';
    const cleanBody = htmlToText(htmlBody, 'html');
    const result = parseTransaction('billing@fal.ai', 'Payment Confirmation', cleanBody, '2026-07-13T02:30:00Z');
    assert.ok(result, 'should parse after htmlToText cleans the wall');
    assert.strictEqual(result.amount, 10.00);
    assert.strictEqual(result.currency, 'USD');
    assert.strictEqual(result.merchant, 'fal.ai');
    assert.strictEqual(result.type, 'topup');
  });

  test('Mox incoming transfer', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '收到款項',
      '收到款項 💰❤️ MR J*** W*** L**已向你付款HKD500.00。若你收到懷疑偽冒我們身份的電郵或電話，請致電28888228',
      '2026-04-10T14:20:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-04-10',
      merchant: 'MR J*** W*** L**',
      amount: 500.00,
      currency: 'HKD',
      source: 'Mox',
      type: 'income'
    });
  });

  test('Mox incoming transfer with CJK payer name', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '收到款項',
      '收到款項 💰❤️ 陳大文已向你付款HKD100.00。若你收到懷疑偽冒我們身份的電郵或電話，請致電28888228',
      '2026-06-15T08:00:00Z'
    );
    assert.strictEqual(result.merchant, '陳大文');
    assert.strictEqual(result.amount, 100.00);
    assert.strictEqual(result.currency, 'HKD');
    assert.strictEqual(result.type, 'income');
  });

  test('Mox incoming transfer merchant excludes subject echo prefix', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '收到款項',
      '收到款項 💰❤️ MS A*** B**已向你付款HKD1,200.00。若你收到懷疑偽冒我們身份的電郵或電話，請致電28888228',
      '2026-05-01T09:00:00Z'
    );
    assert.strictEqual(result.merchant, 'MS A*** B**');
    assert.ok(!result.merchant.includes('收到款項'), 'merchant must not contain subject echo');
  });

  test('Mox refund', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '退款',
      '退款 你獲BEST SHOP退款HKD299.00。如懷疑電28888228若你收到',
      '2026-04-12T11:30:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-04-12',
      merchant: 'BEST SHOP',
      amount: 299.00,
      currency: 'HKD',
      source: 'Mox',
      type: 'refund'
    });
  });

  test('Mox outgoing FPS transfer', () => {
    const result = parseTransaction(
      'notify@mox.com',
      '轉數成功',
      '轉數成功 💸 你已成功在02 Jul 2026 14:05HKT向WONG T*** K** (+852 9123****)付款HKD3,000.00。「轉數快」參考號碼：FRN00000000000',
      '2026-07-02T14:05:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-07-02',
      merchant: 'WONG T*** K**',
      amount: 3000.00,
      currency: 'HKD',
      source: 'Mox',
      type: 'transfer'
    });
  });

  test('Mox income body does not match transfer branch', () => {
    const incomeResult = parseTransaction(
      'notify@mox.com',
      '收到款項',
      '收到款項 💰❤️ LAM S** M**已向你付款HKD800.00。若你收到懷疑偽冒我們身份的電郵或電話，請致電28888228',
      '2026-07-03T10:00:00Z'
    );
    assert.strictEqual(incomeResult.type, 'income', 'income body must hit income branch, not transfer');
    assert.strictEqual(incomeResult.merchant, 'LAM S** M**');
  });

  test('Mox transfer body does not match income branch', () => {
    const transferResult = parseTransaction(
      'notify@mox.com',
      '轉數成功',
      '轉數成功 💸 你已成功在05 Jul 2026 09:30HKT向LEE W** (+852 9876****)付款HKD150.00。「轉數快」參考號碼：FRN11111111111',
      '2026-07-05T09:30:00Z'
    );
    assert.strictEqual(transferResult.type, 'transfer', 'transfer body must hit transfer branch, not income');
    assert.strictEqual(transferResult.merchant, 'LEE W**');
  });

  test('CMHK monthly bill', () => {
    const result = parseTransaction(
      'billing@hk.chinamobile.com',
      '中國移動香港07月份賬單通知',
      '尊敬的客戶，您的07月份賬單已備妥。應繳款項HK$ 188.00 繳款日期03/08/2026賬單發單日期04/07/2026',
      '2026-07-04T00:00:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-07-04',
      merchant: 'CMHK',
      amount: 188.00,
      currency: 'HKD',
      source: 'CMHK',
      type: 'bill'
    });
  });

  test('CMHK bill ignores decoy HK$ amounts after anchor', () => {
    // Body has line-item HK$68.00 and 前期累計 HK$0.00 after the 應繳款項 total
    const body = '尊敬的客戶，您的06月份賬單已備妥。應繳款項HK$ 196.00 繳款日期03/07/2026賬單發單日期04/06/2026 服務費 HK$68.00 增值服務 HK$128.00 前期累計款項HK$0.00';
    const result = parseTransaction(
      'billing@hk.chinamobile.com',
      '中國移動香港06月份賬單通知',
      body,
      '2026-06-04T00:00:00Z'
    );
    assert.strictEqual(result.amount, 196.00, 'must match 應繳款項 anchor, not later HK$ figures');
    assert.strictEqual(result.type, 'bill');
  });

  test('Orb invoice', () => {
    const result = parseTransaction(
      'invoices+cust_abc123@withorb.com',
      'New invoice from Acme Cloud, Inc.',
      'Invoice from Acme Cloud, Inc.: $25.00 due Aug 01, 2026. Invoice No. ABCDEF-00012 $25.00 Payment due Aug 01, 2026 View invoice Memo: pi_test123 Powered by Orb.',
      '2026-07-20T00:00:00Z'
    );
    assert.deepStrictEqual(result, {
      date: '2026-07-20',
      merchant: 'Acme Cloud, Inc.',
      amount: 25.00,
      currency: 'USD',
      source: 'Orb',
      type: 'invoice'
    });
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
