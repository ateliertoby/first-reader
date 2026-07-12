const ACCOUNTING_RULES = [
  { sender: 'mox.com', subject: /交易|消費|Mox Card|轉數|入錢|取消交易|里數/ },
  { sender: 'antbank', subject: /PayLater 付款|轉賬成功|還款成功|部分還款|還款失敗|支付成功/ },
  { sender: 'hsbc', subject: /支付通知|payment transfer|credit advice|Credit Card Transaction|信用卡付款提示|Receipt of an inward|已繳付信用卡/ },
  { sender: 'paypal', subject: /收據|Receipt|付款|提交/ },
  { sender: 'hketoll', subject: /交易通知|繳費通知/ },
  { sender: 'dahsing', subject: /已執行繳費|Card-Not-Present/ },
  { sender: 'mcdonalds', subject: /訂單確認/ },
  { sender: 'sc.com', subject: /Receive Money|收款通知|Send Money/ },
  { sender: 'payme', subject: /轉賬|增值|付款/ },
  { sender: 'hangseng', subject: /成功轉賬/ },
  { sender: 'bowtie', subject: /Payment Successful/i },
  { sender: 'openrouter', subject: /receipt/i },
  { sender: 'anthropic', subject: /receipt/i },
  { sender: 'hushed', subject: /receipt/i },
  { sender: 'globaltel', subject: /料金|引き落とし/ },
  { sender: 'stripe.com', subject: /receipt/i },
];

const NOTIFICATION_RULES = [
  { sender: 'microsoft' },
  { sender: 'github' },
  { sender: 'antbank', subject: /新登入通知|e-Statement|還款提醒/ },
  { sender: 'dahsing', subject: /登入|MyAuto/ },
  { sender: 'transitpay' },
  { sender: 'homeisp' },
  { sender: 'vercel' },
  { sender: 'gridform' },
  { sender: 'openai' },
  { sender: '1010' },
  { sender: 'hkcsl' },
  { sender: 'sc.com', subject: /Payee|Instruction|transfer|防騙|安心/ },
  { sender: 'mallpoints' },
  { sender: 'mox.com', subject: /分期|設立|推薦共賞|騙局|條款修訂|新登入/ },
  { sender: 'payme', subject: /已連結|已被移除|成功登入/ },
  { sender: 'hsbc', subject: /外匯展望/ },
  { sender: 'hangseng', subject: /數碼理財/ },
  // Ads & pure notifications
  { sender: 'facebook' },
  { sender: 'coinport' },
  { sender: 'brokerco' },
  { sender: 'carco' },
  { sender: 'spamsite' },
  { sender: 'eyewear88' },
  { sender: 'sportsclub' },
  { sender: 'cloudflare' },
  { sender: 'domainly' },
  { sender: 'fooddash' },
  { sender: 'travelbook' },
  { sender: 'jobboard' },
  { sender: 'megamall' },
  { sender: 'skyfly' },
  { sender: 'brave' },
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
