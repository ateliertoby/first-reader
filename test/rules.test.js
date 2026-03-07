import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classify } from '../src/sorter/rules.js';

describe('classify', () => {
  test('Mox transaction → accounting', () => {
    assert.strictEqual(classify('notify@mox.com', 'Mox Card交易成功'), 'accounting');
  });
  test('Mox 消費 with miles → accounting', () => {
    assert.strictEqual(classify('notify@mox.com', '交易已完成並可賺取里數！🤩'), 'accounting');
  });
  test('Mox 已取消交易 → accounting', () => {
    assert.strictEqual(classify('notify@mox.com', '已取消交易'), 'accounting');
  });
  test('Mox 轉數成功 → accounting', () => {
    assert.strictEqual(classify('notify@mox.com', '轉數成功'), 'accounting');
  });
  test('Mox 成功入錢 → accounting', () => {
    assert.strictEqual(classify('notify@mox.com', '成功入錢至你在Mox 的戶口'), 'accounting');
  });
  test('Mox 分期設立 → notifications', () => {
    assert.strictEqual(classify('notify@mox.com', '你已成功設立分期及繳交你的月結單結欠'), 'notifications');
  });
  test('Ant Bank PayLater payment → accounting', () => {
    assert.strictEqual(classify('hk_antbank_service@notify.antbank.hk', 'PayLater 付款成功 (PayLater Payment Successful)'), 'accounting');
  });
  test('Ant Bank login → notifications', () => {
    assert.strictEqual(classify('hk_antbank_service@notify.antbank.hk', '新登入通知'), 'notifications');
  });
  test('Ant Bank transfer → accounting', () => {
    assert.strictEqual(classify('hk_antbank_service@notify.antbank.hk', '轉賬成功'), 'accounting');
  });
  test('Ant Bank 還款提醒 → notifications', () => {
    assert.strictEqual(classify('hk_antbank_service@notify.antbank.hk', 'PayLater 還款提醒'), 'notifications');
  });
  test('HSBC payment → accounting', () => {
    assert.strictEqual(classify('HSBC@notification.hsbc.com.hk', '支付通知 Ref:[D0000000001]'), 'accounting');
  });
  test('HSBC transfer credit → accounting', () => {
    assert.strictEqual(classify('HSBC@notification.hsbc.com.hk', 'Fund transfer credit advice 轉賬存款通知書'), 'accounting');
  });
  test('HSBC credit card transaction → accounting', () => {
    assert.strictEqual(classify('HSBC@notification.hsbc.com.hk', 'HSBC Credit Card Transaction Notification'), 'accounting');
  });
  test('PayPal receipt → accounting', () => {
    assert.strictEqual(classify('service@paypal.com.hk', '你付款給 Domainly, Inc 的收據'), 'accounting');
  });
  test('HKeToll transaction → accounting', () => {
    assert.strictEqual(classify('do-not-reply2@hketoll.gov.hk', '易通行交易通知'), 'accounting');
  });
  test('HKeToll payment → accounting', () => {
    assert.strictEqual(classify('do-not-reply2@hketoll.gov.hk', '易通行繳費通知'), 'accounting');
  });
  test('Dah Sing bill payment → accounting', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', '已執行繳費交易'), 'accounting');
  });
  test('Dah Sing login → notifications', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', '登入大新網上理財或流動理財通知'), 'notifications');
  });
  test('McDonald order → accounting', () => {
    assert.strictEqual(classify('DoNotReply@mcdonalds.com', '麥當勞® - 手機訂單確認'), 'accounting');
  });
  test('SC Pay receive → accounting', () => {
    assert.strictEqual(classify('Support.Smsbanking@sc.com', 'Receive Money via Standard Chartered Pay'), 'accounting');
  });
  test('SC Pay 收款 → accounting', () => {
    assert.strictEqual(classify('Support.Smsbanking@sc.com', '收款通知書 – Standard Chartered Pay'), 'accounting');
  });
  test('SC Alerts payee → notifications', () => {
    assert.strictEqual(classify('alerts@sc.com', 'New Payee Added'), 'notifications');
  });
  test('PayMe transfer → accounting', () => {
    assert.strictEqual(classify('some@payme.hsbc.com.hk', '成功轉賬至銀行！'), 'accounting');
  });
  test('PayMe top-up → accounting', () => {
    assert.strictEqual(classify('some@payme.hsbc.com.hk', '您已增值您的PayMe賬戶'), 'accounting');
  });
  test('Hang Seng transfer → accounting', () => {
    assert.strictEqual(classify('some@hangseng.com', '你已成功轉賬(未登記收款人)'), 'accounting');
  });
  test('Microsoft sign-in → notifications', () => {
    assert.strictEqual(classify('account-security-noreply@accountprotection.microsoft.com', 'New sign-in detected'), 'notifications');
  });
  test('GitHub → notifications', () => {
    assert.strictEqual(classify('noreply@github.com', '[GitHub] Please review this sign in'), 'notifications');
  });
  test('Vercel → notifications', () => {
    assert.strictEqual(classify('ship@vercel.com', 'Learn about multi-layer security'), 'notifications');
  });
  test('OpenAI → notifications', () => {
    assert.strictEqual(classify('noreply@email.openai.com', 'Introducing GPT-5.4'), 'notifications');
  });
  test('RunPod → notifications', () => {
    assert.strictEqual(classify('noreply@gridform.example', 'Low Balance Warning'), 'notifications');
  });
  test('HOMEISP → notifications', () => {
    assert.strictEqual(classify('custserv@homeisp.example.hk', 'HOMEISP SHiELD daily report'), 'notifications');
  });
  test('1O1O statement → notifications', () => {
    assert.strictEqual(classify('some@1010.com.hk', '1O1O Mobile Service Monthly Statement'), 'notifications');
  });
  test('Transitpay → notifications', () => {
    assert.strictEqual(classify('some@transitpay.example.hk', '捷通卡App - 生物認證經已啟用'), 'notifications');
  });
  test('MallPoints → notifications', () => {
    assert.strictEqual(classify('some@mallpoints.example', 'MallPoints積分到期提示'), 'notifications');
  });
  test('unknown sender → null', () => {
    assert.strictEqual(classify('random@example.com', 'Hello there'), null);
  });
});
