import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRules, classify, subjectKey } from '../src/sorter/rules.js';

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'rules.json');
const EXAMPLE_PATH = path.join(import.meta.dirname, '..', 'config', 'rules.example.json');

describe('loadRules', () => {
  test('loads and validates config/rules.example.json', () => {
    const config = loadRules(EXAMPLE_PATH);
    assert.ok(Array.isArray(config.guards));
    assert.ok(Array.isArray(config.rules));
    assert.ok(config.rules.length >= 3);
  });

  test('loads test fixture rules.json', () => {
    const config = loadRules(FIXTURE_PATH);
    assert.ok(Array.isArray(config.guards));
    assert.ok(Array.isArray(config.rules));
    assert.strictEqual(config.rules.length, 32);
  });

  test('throws on missing file with bootstrap hint', () => {
    assert.throws(
      () => loadRules('/tmp/nonexistent-outlook-cli-test/rules.json'),
      { message: /Copy config\/rules\.example\.json/ }
    );
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

  test('throws on non-boolean ignoreGuards', () => {
    const tmp = path.join(os.tmpdir(), 'bad-ignoreguards.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'x', bucket: 'accounting', domains: ['x.com'], ignoreGuards: 'yes' }]
    }));
    assert.throws(() => loadRules(tmp), /ignoreGuards must be boolean in rule x/);
    fs.unlinkSync(tmp);
  });

  test('throws on bad subjectExclude regex with rule id in message', () => {
    const tmp = path.join(os.tmpdir(), 'bad-exclude.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: [],
      rules: [{ id: 'myrul', bucket: 'accounting', domains: ['x.com'], subjectExclude: '((' }]
    }));
    assert.throws(() => loadRules(tmp), /bad subjectExclude regex in rule myrul/);
    fs.unlinkSync(tmp);
  });

  test('valid ignoreGuards and subjectExclude load without error', () => {
    const tmp = path.join(os.tmpdir(), 'valid-new-fields.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: ['failed'],
      rules: [{
        id: 'x', bucket: 'accounting', domains: ['x.com'],
        subject: 'tx', subjectExclude: 'refund', ignoreGuards: true
      }]
    }));
    const config = loadRules(tmp);
    assert.strictEqual(config.rules[0].ignoreGuards, true);
    assert.ok(config.rules[0].subjectExcludeRe);
    fs.unlinkSync(tmp);
  });
});

describe('classify', () => {
  const config = loadRules(FIXTURE_PATH);

  // --- Domain matching boundary cases ---

  test('user2020@gmail.com does NOT match 2020.example.hk (label boundary)', () => {
    const r = classify('user2020@gmail.com', '', config);
    assert.strictEqual(r.bucket, null);
  });

  test('misc.com does NOT match quickpay.example (unrelated domain)', () => {
    const r = classify('user@misc.com', 'Receive Money', config);
    assert.strictEqual(r.bucket, null);
  });

  test('subdomain matches: notify.microbank.example.hk matches microbank.example.hk', () => {
    const r = classify('svc@notify.microbank.example.hk', 'PayLater 付款成功', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'microbank-tx');
  });

  test('exact domain match works', () => {
    const r = classify('noreply@codehub.example', 'PR merged', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'codehub');
  });

  // --- Bucket priority ---

  test('accounting beats notifications for same domain when subject matches', () => {
    const r = classify('notify@acmebank.example', 'Acme Card交易成功', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'acmebank-tx');
  });

  // --- Domain specificity ---

  test('fastpay.megabank.example.hk wins over megabank.example.hk (longer domain)', () => {
    const r = classify('some@fastpay.megabank.example.hk', '成功轉賬至銀行！', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'fastpay-tx');
  });

  test('fastpay notification wins over megabank notification (longer domain)', () => {
    const r = classify('no-reply@secure.fastpay.megabank.example.hk', '成功登入FastPay', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'fastpay-notif');
  });

  // --- Guard tests ---

  test('guard blocks: "Direct Debit Instruction Failure Notification" from quickpay.example', () => {
    const r = classify('alerts@quickpay.example', 'Direct Debit Instruction Failure Notification', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'quickpay-notif');
    assert.strictEqual(r.guarded, true);
  });

  test('guard blocks: subject with "declined" on broadrule', () => {
    const r = classify('info@broadrule.example', 'Your request was declined', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'broadrule');
    assert.strictEqual(r.guarded, true);
  });

  test('guard blocks: microbank with failure keyword in subject', () => {
    const r = classify('svc@notify.microbank.example.hk', '轉賬成功 but then 失敗', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'microbank-tx');
    assert.strictEqual(r.guarded, true);
  });

  test('microbank repayment failure -> notifications via ignoreGuards, never accounting', () => {
    const r = classify('svc@notify.microbank.example.hk', 'PayLater 還款失敗（PayLater Autopay Failed）', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'microbank-hk');
    assert.strictEqual(r.guarded, false);
  });

  // --- Accounting parity checks ---

  test('Acmebank 交易 -> accounting', () => {
    const r = classify('notify@acmebank.example', 'Acme Card交易成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Acmebank 消費 with miles -> accounting', () => {
    const r = classify('notify@acmebank.example', '交易已完成並可賺取里數！', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Acmebank 已取消交易 -> accounting', () => {
    const r = classify('notify@acmebank.example', '已取消交易', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Acmebank 轉數成功 -> accounting', () => {
    const r = classify('notify@acmebank.example', '轉數成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Acmebank 成功入錢 -> accounting', () => {
    const r = classify('notify@acmebank.example', '成功入錢至你在Acme 的戶口', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Acmebank 設立分期並繳款 -> accounting (payment event, not marketing)', () => {
    const r = classify('notify@acmebank.example', '你已成功設立分期及繳交你的月結單結欠', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'acmebank-instalment');
  });

  test('Microbank PayLater payment -> accounting', () => {
    const r = classify('svc@notify.microbank.example.hk', 'PayLater 付款成功 (PayLater Payment Successful)', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Microbank transfer -> accounting', () => {
    const r = classify('svc@notify.microbank.example.hk', '轉賬成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Megabank payment -> accounting', () => {
    const r = classify('BANK@notification.megabank.example.hk', '支付通知 Ref:[D0000000001]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Megabank credit card transaction -> accounting', () => {
    const r = classify('BANK@notification.megabank.example.hk', 'Credit Card Transaction Notification', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Walletco receipt -> accounting', () => {
    const r = classify('service@walletco.example.hk', '你付款給 Domainly, Inc 的收據', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Tollgate transaction -> accounting', () => {
    const r = classify('do-not-reply@tollgate.example.hk', '易通行交易通知', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Tollgate 繳費通知 -> notifications (payment reminder, not a transaction)', () => {
    const r = classify('do-not-reply@tollgate.example.hk', '易通行繳費通知', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'tollgate-reminder');
  });

  test('Starbank bill payment -> accounting', () => {
    const r = classify('ebanking@starbank.example', '已執行繳費交易', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Burgerjoint order -> accounting', () => {
    const r = classify('noreply@burgerjoint.example', '手機訂單確認', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('QuickPay receive -> accounting', () => {
    const r = classify('Support@quickpay.example', 'Receive Money via QuickPay', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('QuickPay 收款 -> accounting', () => {
    const r = classify('Support@quickpay.example', '收款通知書 – QuickPay', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('FastPay transfer -> accounting', () => {
    const r = classify('some@fastpay.megabank.example.hk', '成功轉賬至銀行！', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Unionbank transfer -> accounting', () => {
    const r = classify('some@unionbank.example', '你已成功轉賬(未登記收款人)', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Megabank Receipt of inward payment -> accounting', () => {
    const r = classify('BANK@notification.megabank.example.hk', 'Receipt of an inward payment to your credit card account', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Megabank 已繳付信用卡 -> accounting', () => {
    const r = classify('BANK@notification.megabank.example.hk', '您已繳付信用卡款項 Ref:[Z2S00000001]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Starbank Card-Not-Present -> accounting', () => {
    const r = classify('ebanking@starbank.example', 'Starbank: Card-Not-Present Successful Transaction Alert', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('Microbank 支付成功 -> accounting', () => {
    const r = classify('svc@notify.microbank.example.hk', '支付成功', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('QuickPay Send Money -> accounting', () => {
    const r = classify('OnlineBanking@quickpay.example', 'Send Money via QuickPay – Receipt No. 2602-000000000001', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('SaaSCo receipt -> accounting', () => {
    const r = classify('receipts@saasco.example', 'Your receipt [#1111-2222]', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  // --- Notifications parity checks ---

  test('Devtools -> notifications', () => {
    const r = classify('account-security@devtools.example', 'New sign-in detected', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Codehub -> notifications', () => {
    const r = classify('noreply@codehub.example', '[Codehub] Please review this sign in', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Cloudhost -> notifications', () => {
    const r = classify('ship@cloudhost.example', 'Learn about multi-layer security', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Microbank login -> notifications', () => {
    const r = classify('svc@notify.microbank.example.hk', '新登入通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Microbank 還款提醒 -> notifications', () => {
    const r = classify('svc@notify.microbank.example.hk', 'PayLater 還款提醒', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('QuickPay Payee -> notifications', () => {
    const r = classify('alerts@quickpay.example', 'New Payee Added', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Acmebank 推薦共賞 -> notifications', () => {
    const r = classify('info@mailer.acmebank.example', '有關Acme推薦共賞計劃修訂通知', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Acmebank 新登入 -> notifications', () => {
    const r = classify('notify@acmebank.example', '新登入位置', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('FastPay 成功登入 -> notifications', () => {
    const r = classify('no-reply@secure.fastpay.megabank.example.hk', '成功登入FastPay', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Megabank 外匯展望 -> notifications', () => {
    const r = classify('notifications@messaging.megabank.example.hk', '外匯展望 - 2026年2月', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Starbank MyAuto -> notifications', () => {
    const r = classify('ebanking@starbank.example', '【Starbank MyAuto 車主信用卡】最新駕駛資訊', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Unionbank 數碼理財 -> notifications', () => {
    const r = classify('notification@messages.unionbank.example', '數碼理財恒簡單 | 4大轉賬常見疑難', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Socialnet -> notifications', () => {
    const r = classify('security@socialnet.example', '123456 is your security code', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('QuickPay 防騙 -> notifications', () => {
    const r = classify('communications@quickpay.example', '安心迎新年，防騙要留神', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  test('Megabank 信用卡付款提示 -> notifications (bill-due reminder, not a transaction)', () => {
    const r = classify('info@informationservices.megabank.example.hk', '您的信用卡付款提示 Ref:[X0000000001]', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'megabank-card-due');
  });

  // --- Null (stays in inbox) ---

  test('Acmebank 月結單 -> null (stays in inbox)', () => {
    const r = classify('notify@acmebank.example', '已發出本月份Acme戶口月結單', config);
    assert.strictEqual(r.bucket, null);
  });

  test('unknown sender -> null', () => {
    const r = classify('random@example.com', 'Hello there', config);
    assert.strictEqual(r.bucket, null);
  });

  // --- Case-insensitivity ---

  test('subject match is case-insensitive', () => {
    const r = classify('receipts@saasco.example', 'YOUR RECEIPT', config);
    assert.strictEqual(r.bucket, 'accounting');
  });

  test('sender address is case-insensitive', () => {
    const r = classify('NOREPLY@CODEHUB.EXAMPLE', 'test', config);
    assert.strictEqual(r.bucket, 'notifications');
  });

  // --- subjectExclude ---

  test('subjectExclude blocks match: "Acme Card 交易被拒絕" does NOT match acmebank-tx', () => {
    const r = classify('notify@acmebank.example', 'Acme Card 交易被拒絕', config);
    assert.notStrictEqual(r.ruleId, 'acmebank-tx');
  });

  test('subjectExclude does not affect non-matching subjects', () => {
    const r = classify('notify@acmebank.example', '取消交易通知', config);
    assert.strictEqual(r.bucket, 'accounting');
    assert.strictEqual(r.ruleId, 'acmebank-tx');
  });

  // --- keep bucket ---

  test('keep bucket rule matches', () => {
    const r = classify('hello@vip-client.example', 'Important message', config);
    assert.strictEqual(r.bucket, 'keep');
    assert.strictEqual(r.ruleId, 'keep-vip');
  });

  test('keep bucket is never guarded', () => {
    const r = classify('hello@vip-client.example', 'Payment declined notice', config);
    assert.strictEqual(r.bucket, 'keep');
    assert.strictEqual(r.guarded, false);
  });

  // --- probationUntil ---

  test('active probation rule matches', () => {
    const r = classify('info@newservice.example', 'Welcome', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'newservice-active');
  });

  test('expired probation rule still matches (probation is metadata, not a filter)', () => {
    const r = classify('info@oldservice.example', 'Update', config);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'oldservice-expired');
  });
});

describe('classify with fixture configs', () => {
  test('subjectExclude causes fallthrough to next matching rule', () => {
    const tmp = path.join(os.tmpdir(), 'exclude-fixture.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: ['被拒絕'],
      rules: [
        { id: 'acme-tx', bucket: 'accounting', domains: ['acmebank.example'], subject: '交易|Acme Card', subjectExclude: '交易被拒絕' },
        { id: 'acme-notif', bucket: 'notifications', domains: ['acmebank.example'], subject: '分期|設立|新登入' },
        { id: 'acme-all', bucket: 'notifications', domains: ['acmebank.example'] }
      ]
    }));
    const cfg = loadRules(tmp);

    // "Acme Card 交易被拒絕" — excluded from acme-tx, falls through to acme-all (domain catch-all)
    const r = classify('notify@acmebank.example', 'Acme Card 交易被拒絕', cfg);
    assert.strictEqual(r.ruleId, 'acme-all');
    assert.strictEqual(r.bucket, 'notifications');
    // guard "被拒絕" should fire on the fallthrough rule
    assert.strictEqual(r.guarded, true);

    fs.unlinkSync(tmp);
  });

  test('ignoreGuards:true returns guarded:false despite guard words in subject', () => {
    const tmp = path.join(os.tmpdir(), 'ignoreguards-fixture.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: ['失敗', '被拒絕'],
      rules: [
        { id: 'microbank-fail', bucket: 'notifications', domains: ['microbank.example.hk'], subject: '還款失敗', ignoreGuards: true }
      ]
    }));
    const cfg = loadRules(tmp);
    const r = classify('svc@notify.microbank.example.hk', '還款失敗通知', cfg);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'microbank-fail');
    assert.strictEqual(r.guarded, false);
    fs.unlinkSync(tmp);
  });

  test('ignoreGuards absent (default false) -> guarded:true with guard word', () => {
    const tmp = path.join(os.tmpdir(), 'no-ignoreguards-fixture.json');
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1, guards: ['失敗'],
      rules: [
        { id: 'microbank-notif', bucket: 'notifications', domains: ['microbank.example.hk'], subject: '還款' }
      ]
    }));
    const cfg = loadRules(tmp);
    const r = classify('svc@notify.microbank.example.hk', '還款失敗', cfg);
    assert.strictEqual(r.bucket, 'notifications');
    assert.strictEqual(r.ruleId, 'microbank-notif');
    assert.strictEqual(r.guarded, true);
    fs.unlinkSync(tmp);
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
