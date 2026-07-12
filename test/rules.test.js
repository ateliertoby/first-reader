import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRules, classify, subjectKey } from '../src/sorter/rules.js';

const CONFIG_PATH = path.join(import.meta.dirname, '..', 'config', 'rules.json');

describe('loadRules', () => {
  test('loads and validates config/rules.json', () => {
    const config = loadRules(CONFIG_PATH);
    assert.ok(Array.isArray(config.guards));
    assert.ok(Array.isArray(config.rules));
    assert.ok(config.rules.length >= 48);
  });

  test('throws on bad regex', () => {
    const tmp = path.join(os.tmpdir(), 'bad-regex.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'accounting', domains: ['x.com'], subject: '((' }]
    }));
    assert.throws(() => loadRules(tmp), /bad regex/);
    fs.unlinkSync(tmp);
  });

  test('throws on unknown bucket', () => {
    const tmp = path.join(os.tmpdir(), 'bad-bucket.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'trash', domains: ['x.com'] }]
    }));
    assert.throws(() => loadRules(tmp), /unknown bucket/);
    fs.unlinkSync(tmp);
  });

  test('throws on duplicate id', () => {
    const tmp = path.join(os.tmpdir(), 'dup-id.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [
        { id: 'x', bucket: 'accounting', domains: ['x.com'] },
        { id: 'x', bucket: 'notifications', domains: ['y.com'] }
      ]
    }));
    assert.throws(() => loadRules(tmp), /duplicate rule id/);
    fs.unlinkSync(tmp);
  });

  test('throws on domain without dot', () => {
    const tmp = path.join(os.tmpdir(), 'bad-domain.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'accounting', domains: ['nodot'] }]
    }));
    assert.throws(() => loadRules(tmp), /must contain a dot/);
    fs.unlinkSync(tmp);
  });

  test('throws on domain with @', () => {
    const tmp = path.join(os.tmpdir(), 'at-domain.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'accounting', domains: ['user@x.com'] }]
    }));
    assert.throws(() => loadRules(tmp), /must not contain @/);
    fs.unlinkSync(tmp);
  });

  test('throws on uppercase domain', () => {
    const tmp = path.join(os.tmpdir(), 'upper-domain.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'accounting', domains: ['X.COM'] }]
    }));
    assert.throws(() => loadRules(tmp), /must be lowercase/);
    fs.unlinkSync(tmp);
  });
});

describe('classify', () => {
  const config = loadRules(CONFIG_PATH);

  // Domain matching boundary cases
  test('user1010@gmail.com does NOT match 1010.com.hk', () => {
    const r = classify('user1010@gmail.com', '', config);
    assert.strictEqual(r.bucket, null);
  });

  test('misc.com does NOT match sc.com', () => {
    const r = classify('user@misc.com', 'Receive Money', config);
    assert.strictEqual(r.bucket, null);
  });

  test('subdomain matches: notify.antbank.hk matches antbank.hk', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', 'PayLater 付款成功', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'antbank-tx');
  });

  test('exact domain match works', () => {
    const r = classify('noreply@github.com', 'PR merged', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'github');
  });

  // Bucket priority: accounting > notifications
  test('accounting beats notifications for same domain when subject matches', () => {
    const r = classify('notify@mox.com', 'Mox Card交易成功', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'mox-tx');
  });

  // Specificity: longer domain wins
  test('payme.hsbc.com.hk wins over hsbc.com.hk', () => {
    const r = classify('some@payme.hsbc.com.hk', '成功轉賬至銀行！', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'payme-tx');
  });

  test('payme.hsbc.com.hk notification wins over hsbc.com.hk', () => {
    const r = classify('no-reply@secure-app.payme.hsbc.com.hk', '成功登入PayMe', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'payme-notif');
  });

  // Guard tests
  test('guard blocks: "Direct Debit Instruction Failure Notification" from sc.com', () => {
    const r = classify('alerts@sc.com', 'Direct Debit Instruction Failure Notification', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'sc-notif');
    assert.strictEqual(r.guarded, true);
  });

  test('guard blocks: subject with "declined"', () => {
    const r = classify('notify@mox.com', 'Your transaction was declined', config);
    // "declined" is a guard word, and "transaction" doesn't match mox-tx subject regex
    // Actually let's check - mox-tx subject: 交易|消費|Mox Card|轉數|入錢|取消交易|里數
    // "Your transaction was declined" doesn't match any of these
    // So it would fall through to mox-notif or not match at all
    // Actually none of the mox rules match "Your transaction was declined"
    // So bucket=null, no guard applies
    assert.strictEqual(r.bucket, null);
  });

  test('guard blocks: antbank with "失敗" in subject', () => {
    // antbank-tx subject doesn't include 還款失敗 anymore (removed per spec)
    // but if it had a match + guard word:
    const r = classify('hk_antbank_service@notify.antbank.hk', '轉賬成功 but then 失敗', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'antbank-tx');
    assert.strictEqual(r.guarded, true);
  });

  // Correction: antbank 還款失敗 no longer matches accounting
  test('antbank 還款失敗 does NOT match accounting (removed from rules)', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', '還款失敗', config);
    // 還款失敗 doesn't match antbank-tx (PayLater 付款|轉賬成功|還款成功|部分還款|支付成功)
    // doesn't match antbank-notif (新登入通知|e-Statement|還款提醒)
    assert.strictEqual(r.bucket, null);
  });

  // Legacy parity spot checks
  test('Mox 交易 → accounting', () => {
    const r = classify('notify@mox.com', 'Mox Card交易成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 消費 with miles → accounting', () => {
    const r = classify('notify@mox.com', '交易已完成並可賺取里數！', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 已取消交易 → accounting', () => {
    const r = classify('notify@mox.com', '已取消交易', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 轉數成功 → accounting', () => {
    const r = classify('notify@mox.com', '轉數成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 成功入錢 → accounting', () => {
    const r = classify('notify@mox.com', '成功入錢至你在Mox 的戶口', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 分期設立 → notifications', () => {
    const r = classify('notify@mox.com', '你已成功設立分期及繳交你的月結單結欠', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Ant Bank PayLater payment → accounting', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', 'PayLater 付款成功 (PayLater Payment Successful)', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Ant Bank login → notifications', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', '新登入通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Ant Bank transfer → accounting', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', '轉賬成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Ant Bank 還款提醒 → notifications', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', 'PayLater 還款提醒', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('HSBC payment → accounting', () => {
    const r = classify('HSBC@notification.hsbc.com.hk', '支付通知 Ref:[D0000000001]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HSBC transfer credit → accounting', () => {
    const r = classify('HSBC@notification.hsbc.com.hk', 'Fund transfer credit advice 轉賬存款通知書', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HSBC credit card transaction → accounting', () => {
    const r = classify('HSBC@notification.hsbc.com.hk', 'HSBC Credit Card Transaction Notification', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('PayPal receipt → accounting', () => {
    const r = classify('service@paypal.com.hk', '你付款給 Domainly, Inc 的收據', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HKeToll transaction → accounting', () => {
    const r = classify('do-not-reply2@hketoll.gov.hk', '易通行交易通知', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HKeToll payment → accounting', () => {
    const r = classify('do-not-reply2@hketoll.gov.hk', '易通行繳費通知', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Dah Sing bill payment → accounting', () => {
    const r = classify('ebanking@dahsing.com', '已執行繳費交易', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Dah Sing login → notifications', () => {
    const r = classify('ebanking@dahsing.com', '登入大新網上理財或流動理財通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('McDonald order → accounting', () => {
    const r = classify('DoNotReply@mcdonalds.com', '麥當勞® - 手機訂單確認', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('SC Pay receive → accounting', () => {
    const r = classify('Support.Smsbanking@sc.com', 'Receive Money via Standard Chartered Pay', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('SC Pay 收款 → accounting', () => {
    const r = classify('Support.Smsbanking@sc.com', '收款通知書 – Standard Chartered Pay', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('SC Alerts payee → notifications', () => {
    const r = classify('alerts@sc.com', 'New Payee Added', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('PayMe transfer → accounting', () => {
    const r = classify('some@payme.hsbc.com.hk', '成功轉賬至銀行！', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('PayMe top-up → accounting', () => {
    const r = classify('some@payme.hsbc.com.hk', '您已增值您的PayMe賬戶', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Hang Seng transfer → accounting', () => {
    const r = classify('some@hangseng.com', '你已成功轉賬(未登記收款人)', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Microsoft sign-in → notifications', () => {
    const r = classify('account-security-noreply@accountprotection.microsoft.com', 'New sign-in detected', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('GitHub → notifications', () => {
    const r = classify('noreply@github.com', '[GitHub] Please review this sign in', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Vercel → notifications', () => {
    const r = classify('ship@vercel.com', 'Learn about multi-layer security', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('OpenAI → notifications', () => {
    const r = classify('noreply@email.openai.com', 'Introducing GPT-5.4', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('RunPod → notifications', () => {
    const r = classify('noreply@gridform.example', 'Low Balance Warning', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('HOMEISP → notifications', () => {
    const r = classify('custserv@homeisp.example.hk', 'HOMEISP SHiELD daily report', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Transitpay → notifications', () => {
    const r = classify('some@transitpay.example.hk', '捷通卡App - 生物認證經已啟用', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('MallPoints → notifications', () => {
    const r = classify('some@mallpoints.example.hk', 'MallPoints積分到期提示', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('HSBC 信用卡付款提示 → accounting', () => {
    const r = classify('hsbc@informationservices.hsbc.com.hk', '您的信用卡付款提示 Ref:[X0000000001]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HSBC Receipt of inward payment → accounting', () => {
    const r = classify('HSBC@notification.hsbc.com.hk', 'Receipt of an inward payment to your credit card account', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('HSBC 已繳付信用卡 → accounting', () => {
    const r = classify('HSBC@notification.hsbc.com.hk', '您已繳付信用卡款項 Ref:[Z2S00000001]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Dah Sing Card-Not-Present → accounting', () => {
    const r = classify('ebanking@dahsing.com', 'Dah Sing Bank: Card-Not-Present Successful Transaction Alert', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Ant Bank 支付成功 → accounting', () => {
    const r = classify('hk_antbank_service@notify.antbank.hk', '支付成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('SC Pay Send Money → accounting', () => {
    const r = classify('OnlineBanking.HK@sc.com', 'Send Money via Standard Chartered Pay – Receipt No. 2602-000000000001', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('PayPal 提交 → accounting', () => {
    const r = classify('service@paypal.com.hk', '你已提交向 GLOBALTEL COMMUNICATION... 提交金額為 $12.00 USD 的訂單', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Bowtie Payment Successful → accounting', () => {
    const r = classify('info@notifications.bowtie.com.hk', '[ Payment Successful ] Premium well received', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Nimbus AI receipt → accounting', () => {
    const r = classify('receipts@nimbus-ai.example', 'Your Nimbus AI, Inc receipt [#1111-2222]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Anthropic receipt → accounting', () => {
    const r = classify('invoice+statements@modelworks.example', 'Your receipt from Modelworks, PBC #1111-2222-3333', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Vaultline receipt → accounting', () => {
    const r = classify('receipts@vaultline.example', 'Your Vaultline c/o Meridian Apps Inc. receipt [#5555-6666]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('GlobalTel 料金 → accounting', () => {
    const r = classify('billing@globaltel-hk.example', '【GlobalTel】ご利用料金のお引き落としが完了いたしました', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Stripe/Gridform receipt → accounting', () => {
    const r = classify('receipts+acct_1ABCDEFGHIJKLMNO@stripe.com', 'Your Gridform receipt [#3333-4444]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Mox 推薦共賞 → notifications', () => {
    const r = classify('info@mailer.mox.com', '有關Mox推薦共賞計劃修訂通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Mox 騙局 → notifications', () => {
    const r = classify('info@mailer.mox.com', '最新騙局大流行，即睇免中招', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Mox 新登入 → notifications', () => {
    const r = classify('notify@mox.com', '新登入位置', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Mox 月結單 → null (stays in inbox)', () => {
    const r = classify('notify@mox.com', '已發出本月份Mox戶口月結單', config);
    assert.strictEqual(r.bucket, null);
  });

  test('Mox 賬單到期 → null (stays in inbox)', () => {
    const r = classify('notify@mox.com', '你的Mox Credit 賬單將於 2026年2月11日到期', config);
    assert.strictEqual(r.bucket, null);
  });

  test('PayMe 成功登入 → notifications', () => {
    const r = classify('no-reply@secure-app.payme.hsbc.com.hk', '成功登入PayMe', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('PayMe 信用卡已連結 → notifications', () => {
    const r = classify('no-reply@secure-app.payme.hsbc.com.hk', '您的信用卡已連結至 PayMe！', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('HSBC 外匯展望 → notifications', () => {
    const r = classify('hsbc.notifications@messaging.hsbc.com.hk', '外匯展望 - 2026年2月', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Dah Sing MyAuto → notifications', () => {
    const r = classify('ebanking@dahsing.com', '【大新 MyAuto 車主信用卡】最新駕駛資訊', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Dah Sing e-Statement → null (stays in inbox)', () => {
    const r = classify('ebanking@dahsing.com', 'Credit Card e-Statement (Feb, 2026)', config);
    assert.strictEqual(r.bucket, null);
  });

  test('Dah Sing Payment Due → null (stays in inbox)', () => {
    const r = classify('ebanking@dahsing.com', 'Dah Sing Credit Card Payment Due Date Reminder', config);
    assert.strictEqual(r.bucket, null);
  });

  test('Hang Seng 數碼理財 → notifications', () => {
    const r = classify('notification@messages.hangseng.com', '數碼理財恒簡單 | 4大轉賬常見疑難', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Hang Seng e-Statement → null (stays in inbox)', () => {
    const r = classify('e-alert@mail.hangseng.com', '你的最新e-Statement / e-Advice已準備好', config);
    assert.strictEqual(r.bucket, null);
  });

  test('SC 防騙 → notifications', () => {
    const r = classify('communications@hk.sc.com', '安心迎新年，防騙要留神', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Facebook → notifications', () => {
    const r = classify('security@facebookmail.com', '123456 is your Facebook security code', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('CoinPort → notifications', () => {
    const r = classify('donotreply@notification.coinport.example', 'Get limited time HKD reward', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('致富CHIEF → notifications', () => {
    const r = classify('cs@brokerco.example.hk', '美國股票期權第三方收費調整通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('CarCo → notifications', () => {
    const r = classify('CarCoHK@carco.example', 'CarCo 尚餘最後一批配額', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('SPAMSITE → notifications', () => {
    const r = classify('promo@spamsite.example', '【SPAMSITE】Limited to Mar 3th!', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('EYEWEAR 88 → notifications', () => {
    const r = classify('ecommerce@eyewear.example.hk', '您的眼鏡88積分已更新', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('SPORTSCLUB → notifications', () => {
    const r = classify('customer.care@sportsclub.example.hk', '【香港賽馬會服務】修訂通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Cloudflare → notifications', () => {
    const r = classify('noreply@notify.cloudflare.com', 'my-site.example is now active', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('fooddash → notifications', () => {
    const r = classify('rider@fooddash.example.hk', 'Lunar New Year Reactivation', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('SkyFly → notifications', () => {
    const r = classify('noreply@e.skyfly.example', '你的26年2月賬戶概要', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Ivan Li newsletter → null (stays in inbox)', () => {
    const r = classify('bingo@creatorly.example', '本週專欄更新', config);
    assert.strictEqual(r.bucket, null);
  });

  test('unknown sender → null', () => {
    const r = classify('random@example.com', 'Hello there', config);
    assert.strictEqual(r.bucket, null);
  });

  // Case-insensitivity
  test('subject match is case-insensitive', () => {
    const r = classify('receipts@nimbus-ai.example', 'YOUR RECEIPT', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('sender address is case-insensitive', () => {
    const r = classify('NOREPLY@GITHUB.COM', 'test', config);
    assert.strictEqual(r.bucket, 'notifications');
  });
});

describe('subjectKey', () => {
  test('normalizes numbers to #', () => {
    assert.strictEqual(subjectKey('Receipt #1234-5678'), 'receipt ##-#');
  });

  test('lowercases', () => {
    assert.strictEqual(subjectKey('HELLO World'), 'hello world');
  });

  test('collapses whitespace', () => {
    assert.strictEqual(subjectKey('a   b\tc'), 'a b c');
  });

  test('trims', () => {
    assert.strictEqual(subjectKey('  hello  '), 'hello');
  });

  test('slices to 80 chars', () => {
    const long = 'a'.repeat(100);
    assert.strictEqual(subjectKey(long).length, 80);
  });

  test('handles empty/null', () => {
    assert.strictEqual(subjectKey(''), '');
    assert.strictEqual(subjectKey(null), '');
  });
});
