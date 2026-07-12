function extractDate(dateStr) {
  return new Date(dateStr).toISOString().split('T')[0];
}

function parseMox(body, dateStr) {
  const match = body.match(/你已在(.+?)消費(HKD|USD)([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: match[1],
      amount: parseFloat(match[3].replace(/,/g, '')),
      currency: match[2],
      source: 'Mox',
      type: 'payment'
    };
  }
  return null;
}

function parseAntBank(body, dateStr) {
  const match = body.match(/payment of HK\$([\d,.]+)/i);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: null,
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Ant Bank',
      type: 'payment'
    };
  }
  // 支付成功: "debited HKD38.00" / "扣取HKD38.00"
  const debitMatch = body.match(/(?:debited|扣取)\s*(HKD|USD)([\d,.]+)/i);
  if (debitMatch) {
    return {
      date: extractDate(dateStr),
      merchant: null,
      amount: parseFloat(debitMatch[2].replace(/,/g, '')),
      currency: debitMatch[1].toUpperCase(),
      source: 'Ant Bank',
      type: 'payment'
    };
  }
  const transferMatch = body.match(/HK\$([\d,.]+)/);
  if (transferMatch) {
    return {
      date: extractDate(dateStr),
      merchant: null,
      amount: parseFloat(transferMatch[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Ant Bank',
      type: 'transfer'
    };
  }
  return null;
}

function parseHSBC(body, dateStr) {
  const match = body.match(/將\s+(HKD)([\d,.]+)\s+轉往\s+(.+?)\s*[。.]/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: match[3].trim(),
      amount: parseFloat(match[2].replace(/,/g, '')),
      currency: 'HKD',
      source: 'HSBC',
      type: 'transfer'
    };
  }
  const payMatch = body.match(/(HKD|USD)([\d,.]+)/);
  if (payMatch) {
    return {
      date: extractDate(dateStr),
      merchant: null,
      amount: parseFloat(payMatch[2].replace(/,/g, '')),
      currency: payMatch[1],
      source: 'HSBC',
      type: 'payment'
    };
  }
  return null;
}

function parsePayPal(body, dateStr) {
  const match = body.match(/你已支付\s+\$([\d,.]+)\s+(USD|HKD)\s+給\s+(.+?)[\n\r]/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: match[3].trim(),
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: match[2],
      source: 'PayPal',
      type: 'payment'
    };
  }
  // 訂購 format: "你已向 MERCHANT 訂購 $12.00 USD"
  const orderMatch = body.match(/你已向\s+(.+?)\s+(?:\(.*?\)\s+)?訂購\s+\$([\d,.]+)\s+(USD|HKD)/);
  if (orderMatch) {
    return {
      date: extractDate(dateStr),
      merchant: orderMatch[1].trim(),
      amount: parseFloat(orderMatch[2].replace(/,/g, '')),
      currency: orderMatch[3],
      source: 'PayPal',
      type: 'payment'
    };
  }
  return null;
}

function parseHKeToll(body, dateStr) {
  const match = body.match(/駛經(.+?)，隧道費為HK\$([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: match[1],
      amount: parseFloat(match[2].replace(/,/g, '')),
      currency: 'HKD',
      source: 'HKeToll',
      type: 'toll'
    };
  }
  const payMatch = body.match(/HK\$([\d,.]+)/);
  if (payMatch) {
    return {
      date: extractDate(dateStr),
      merchant: 'HKeToll',
      amount: parseFloat(payMatch[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'HKeToll',
      type: 'toll'
    };
  }
  return null;
}

function parseDahSing(body, dateStr) {
  const amountMatch = body.match(/繳費金額：港元\s+([\d,.]+)/);
  const merchantMatch = body.match(/商戶名稱：(.+?)[\s\n]/);
  if (amountMatch) {
    return {
      date: extractDate(dateStr),
      merchant: merchantMatch ? merchantMatch[1].trim() : null,
      amount: parseFloat(amountMatch[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Dah Sing',
      type: 'payment'
    };
  }
  // Card-Not-Present transaction
  const cnpAmount = body.match(/Transaction Amount:(HKD|USD)\s*([\d,.]+)/i) || body.match(/交易金額：(HKD|USD)\s*([\d,.]+)/);
  const cnpMerchant = body.match(/Merchant:\s*(.+?)(?:Transaction)/i) || body.match(/商戶：(.+?)(?:交易)/);
  if (cnpAmount) {
    return {
      date: extractDate(dateStr),
      merchant: cnpMerchant ? cnpMerchant[1].trim() : null,
      amount: parseFloat(cnpAmount[2].replace(/,/g, '')),
      currency: cnpAmount[1].toUpperCase(),
      source: 'Dah Sing',
      type: 'payment'
    };
  }
  return null;
}

function parseMcDonalds(body, dateStr) {
  const match = body.match(/總計：\s*\n?\s*HKD([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: "McDonald's",
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: 'HKD',
      source: "McDonald's",
      type: 'payment'
    };
  }
  return null;
}

function parseSCPay(body, dateStr) {
  const match = body.match(/HK\$([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: 'SC Pay',
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Standard Chartered',
      type: 'transfer'
    };
  }
  return null;
}

function parsePayMe(body, dateStr) {
  const match = body.match(/HK\$([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: 'PayMe',
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'PayMe',
      type: 'transfer'
    };
  }
  return null;
}

function parseHangSeng(body, dateStr) {
  const match = body.match(/HK\$([\d,.]+)/);
  if (match) {
    return {
      date: extractDate(dateStr),
      merchant: null,
      amount: parseFloat(match[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Hang Seng',
      type: 'transfer'
    };
  }
  return null;
}

function parseStripeReceipt(body, dateStr) {
  const amountMatch = body.match(/Amount paid \$([\d,.]+)/);
  const merchantMatch = body.match(/Receipt from (.+?)\s*[\[#]/);
  if (amountMatch) {
    return {
      date: extractDate(dateStr),
      merchant: merchantMatch ? merchantMatch[1].trim() : null,
      amount: parseFloat(amountMatch[1].replace(/,/g, '')),
      currency: 'USD',
      source: merchantMatch ? merchantMatch[1].trim() : 'Stripe',
      type: 'payment'
    };
  }
  return null;
}

function parseBowtie(body, dateStr) {
  const amountMatch = body.match(/(?:HKD|HK\$)\s*([\d,.]+)/i) || body.match(/premium.*?\$([\d,.]+)/i);
  if (amountMatch) {
    return {
      date: extractDate(dateStr),
      merchant: 'Bowtie',
      amount: parseFloat(amountMatch[1].replace(/,/g, '')),
      currency: 'HKD',
      source: 'Bowtie',
      type: 'insurance'
    };
  }
  return null;
}

const PARSERS = [
  { sender: 'mox.com', parse: parseMox },
  { sender: 'antbank', parse: parseAntBank },
  { sender: 'hsbc.com', parse: parseHSBC },
  { sender: 'paypal', parse: parsePayPal },
  { sender: 'hketoll', parse: parseHKeToll },
  { sender: 'dahsing', parse: parseDahSing },
  { sender: 'mcdonalds', parse: parseMcDonalds },
  { sender: 'sc.com', parse: parseSCPay },
  { sender: 'payme', parse: parsePayMe },
  { sender: 'hangseng', parse: parseHangSeng },
  { sender: 'bowtie', parse: parseBowtie },
  { sender: 'openrouter', parse: parseStripeReceipt },
  { sender: 'anthropic', parse: parseStripeReceipt },
  { sender: 'hushed', parse: parseStripeReceipt },
  { sender: 'stripe.com', parse: parseStripeReceipt },
];

export function parseTransaction(senderAddress, subject, body, dateStr) {
  const addr = senderAddress.toLowerCase();
  for (const { sender, parse } of PARSERS) {
    if (addr.includes(sender)) {
      return parse(body, dateStr);
    }
  }
  return null;
}
