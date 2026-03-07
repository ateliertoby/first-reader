const ACCOUNTING_RULES = [
  { sender: 'mox.com', subject: /交易|消費|Mox Card|轉數|入錢|取消交易|里數/ },
  { sender: 'antbank', subject: /PayLater 付款|轉賬成功|還款成功|部分還款|還款失敗/ },
  { sender: 'hsbc', subject: /支付通知|payment transfer|credit advice|Credit Card Transaction/ },
  { sender: 'paypal', subject: /收據|Receipt|付款/ },
  { sender: 'hketoll', subject: /交易通知|繳費通知/ },
  { sender: 'dahsing', subject: /已執行繳費/ },
  { sender: 'mcdonalds', subject: /訂單確認/ },
  { sender: 'sc.com', subject: /Receive Money|收款通知/ },
  { sender: 'payme', subject: /轉賬|增值|付款/ },
  { sender: 'hangseng', subject: /成功轉賬/ },
];

const NOTIFICATION_RULES = [
  { sender: 'microsoft' },
  { sender: 'github' },
  { sender: 'antbank', subject: /新登入通知|e-Statement|還款提醒/ },
  { sender: 'dahsing', subject: /登入/ },
  { sender: 'transitpay' },
  { sender: 'homeisp' },
  { sender: 'vercel' },
  { sender: 'gridform' },
  { sender: 'openai' },
  { sender: '1010', },
  { sender: 'sc.com', subject: /Payee|Instruction|transfer/ },
  { sender: 'mallpoints' },
  { sender: 'mox.com', subject: /分期|設立/ },
];

export function classify(senderAddress, subject) {
  const addr = senderAddress.toLowerCase();
  const subj = subject || '';

  for (const rule of ACCOUNTING_RULES) {
    if (addr.includes(rule.sender)) {
      if (rule.subject) {
        if (rule.subject.test(subj)) return 'accounting';
      } else {
        return 'accounting';
      }
    }
  }

  for (const rule of NOTIFICATION_RULES) {
    if (addr.includes(rule.sender)) {
      if (rule.subject) {
        if (rule.subject.test(subj)) return 'notifications';
      } else {
        return 'notifications';
      }
    }
  }

  return null;
}
