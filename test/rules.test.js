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
  // New accounting rules
  test('HSBC 信用卡付款提示 → accounting', () => {
    assert.strictEqual(classify('hsbc@informationservices.hsbc.com.hk', '您的信用卡付款提示 Ref:[X0000000001]'), 'accounting');
  });
  test('HSBC Receipt of inward payment → accounting', () => {
    assert.strictEqual(classify('HSBC@notification.hsbc.com.hk', 'Receipt of an inward payment to your credit card account'), 'accounting');
  });
  test('HSBC 已繳付信用卡 → accounting', () => {
    assert.strictEqual(classify('HSBC@notification.hsbc.com.hk', '您已繳付信用卡款項 Ref:[Z2S00000001]'), 'accounting');
  });
  test('Dah Sing Card-Not-Present → accounting', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', 'Dah Sing Bank: Card-Not-Present Successful Transaction Alert'), 'accounting');
  });
  test('Ant Bank 支付成功 → accounting', () => {
    assert.strictEqual(classify('hk_antbank_service@notify.antbank.hk', '支付成功'), 'accounting');
  });
  test('SC Pay Send Money → accounting', () => {
    assert.strictEqual(classify('OnlineBanking.HK@sc.com', 'Send Money via Standard Chartered Pay – Receipt No. 2602-000000000001'), 'accounting');
  });
  test('PayPal 提交 → accounting', () => {
    assert.strictEqual(classify('service@paypal.com.hk', '你已提交向 GLOBALTEL COMMUNICATION... 提交金額為 $12.00 USD 的訂單'), 'accounting');
  });
  test('Bowtie Payment Successful → accounting', () => {
    assert.strictEqual(classify('info@notifications.bowtie.com.hk', '[ Payment Successful ] Premium well received'), 'accounting');
  });
  test('Nimbus AI receipt → accounting', () => {
    assert.strictEqual(classify('receipts@nimbus-ai.example', 'Your Nimbus AI, Inc receipt [#1111-2222]'), 'accounting');
  });
  test('Anthropic receipt → accounting', () => {
    assert.strictEqual(classify('invoice+statements@modelworks.example', 'Your receipt from Modelworks, PBC #1111-2222-3333'), 'accounting');
  });
  test('Vaultline receipt → accounting', () => {
    assert.strictEqual(classify('receipts@vaultline.example', 'Your Vaultline c/o Meridian Apps Inc. receipt [#5555-6666]'), 'accounting');
  });
  test('GlobalTel 料金 → accounting', () => {
    assert.strictEqual(classify('billing@globaltel-hk.example', '【GlobalTel】ご利用料金のお引き落としが完了いたしました'), 'accounting');
  });
  test('Stripe/Gridform receipt → accounting', () => {
    assert.strictEqual(classify('receipts+acct_1ABCDEFGHIJKLMNO@stripe.com', 'Your Gridform receipt [#3333-4444]'), 'accounting');
  });

  // New notification rules
  test('Mox 推薦共賞 → notifications', () => {
    assert.strictEqual(classify('info@mailer.mox.com', '有關Mox推薦共賞計劃修訂通知'), 'notifications');
  });
  test('Mox 騙局 → notifications', () => {
    assert.strictEqual(classify('info@mailer.mox.com', '最新騙局大流行，即睇免中招'), 'notifications');
  });
  test('Mox 新登入 → notifications', () => {
    assert.strictEqual(classify('notify@mox.com', '新登入位置'), 'notifications');
  });
  test('Mox 月結單 → stays in inbox (null)', () => {
    assert.strictEqual(classify('notify@mox.com', '已發出本月份Mox戶口月結單'), null);
  });
  test('Mox 賬單到期 → stays in inbox (null)', () => {
    assert.strictEqual(classify('notify@mox.com', '你的Mox Credit 賬單將於 2026年2月11日到期'), null);
  });
  test('PayMe 成功登入 → notifications', () => {
    assert.strictEqual(classify('no-reply@secure-app.payme.hsbc.com.hk', '成功登入PayMe'), 'notifications');
  });
  test('PayMe 信用卡已連結 → notifications', () => {
    assert.strictEqual(classify('no-reply@secure-app.payme.hsbc.com.hk', '您的信用卡已連結至 PayMe！'), 'notifications');
  });
  test('HSBC 外匯展望 → notifications', () => {
    assert.strictEqual(classify('hsbc.notifications@messaging.hsbc.com.hk', '外匯展望 - 2026年2月'), 'notifications');
  });
  test('Dah Sing MyAuto → notifications', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', '【大新 MyAuto 車主信用卡】最新駕駛資訊'), 'notifications');
  });
  test('Dah Sing e-Statement → stays in inbox (null)', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', 'Credit Card e-Statement (Feb, 2026)'), null);
  });
  test('Dah Sing Payment Due → stays in inbox (null)', () => {
    assert.strictEqual(classify('ebanking@dahsing.com', 'Dah Sing Credit Card Payment Due Date Reminder'), null);
  });
  test('Hang Seng 數碼理財 → notifications', () => {
    assert.strictEqual(classify('notification@messages.hangseng.com', '數碼理財恒簡單 | 4大轉賬常見疑難'), 'notifications');
  });
  test('Hang Seng e-Statement → stays in inbox (null)', () => {
    assert.strictEqual(classify('e-alert@mail.hangseng.com', '你的最新e-Statement / e-Advice已準備好'), null);
  });
  test('SC 防騙 → notifications', () => {
    assert.strictEqual(classify('communications@hk.sc.com', '安心迎新年，防騙要留神'), 'notifications');
  });
  test('Facebook → notifications', () => {
    assert.strictEqual(classify('security@facebookmail.com', '123456 is your Facebook security code'), 'notifications');
  });
  test('CoinPort → notifications', () => {
    assert.strictEqual(classify('donotreply@notification.coinport.example', 'Get limited time HKD reward'), 'notifications');
  });
  test('致富CHIEF → notifications', () => {
    assert.strictEqual(classify('cs@brokerco.example.hk', '美國股票期權第三方收費調整通知'), 'notifications');
  });
  test('CarCo → notifications', () => {
    assert.strictEqual(classify('CarCoHK@carco.example', 'CarCo 尚餘最後一批配額'), 'notifications');
  });
  test('SPAMSITE → notifications', () => {
    assert.strictEqual(classify('promo@spamsite.example', '【SPAMSITE】Limited to Mar 3th!'), 'notifications');
  });
  test('EYEWEAR 88 → notifications', () => {
    assert.strictEqual(classify('ecommerce@eyewear.example.hk', '您的眼鏡88積分已更新'), 'notifications');
  });
  test('SPORTSCLUB → notifications', () => {
    assert.strictEqual(classify('customer.care@sportsclub.example.hk', '【香港賽馬會服務】修訂通知'), 'notifications');
  });
  test('Cloudflare → notifications', () => {
    assert.strictEqual(classify('noreply@notify.cloudflare.com', 'my-site.example is now active'), 'notifications');
  });
  test('fooddash → notifications', () => {
    assert.strictEqual(classify('rider@fooddash.example.hk', 'Lunar New Year Reactivation'), 'notifications');
  });
  test('SkyFly → notifications', () => {
    assert.strictEqual(classify('noreply@e.skyfly.example', '你的26年2月賬戶概要'), 'notifications');
  });

  // Ivan Li newsletter → stays in inbox
  test('Ivan Li newsletter → stays in inbox (null)', () => {
    assert.strictEqual(classify('bingo@creatorly.example', '本週專欄更新'), null);
  });

  test('unknown sender → null', () => {
    assert.strictEqual(classify('random@example.com', 'Hello there'), null);
  });
});
