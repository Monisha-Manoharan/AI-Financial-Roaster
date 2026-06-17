const express = require('express');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Helper: Programmatically write/update key in .env file
function updateEnvFile(key, value) {
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  const reg = new RegExp(`^${key}=.*$`, 'm');
  if (reg.test(envContent)) {
    envContent = envContent.replace(reg, `${key}=${value}`);
  } else {
    envContent += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory configuration store for dynamic API Key / Persona settings
// Reads persona from .env so it persists across server restarts
let systemConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  persona: process.env.PERSONA || 'aggressive', // 'aggressive', 'sarcastic', 'supportive'
  dailyBriefing: true,
  realtimeShame: true
};

// PostgreSQL pool configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase external connections
  }
});

// Test Database Connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('Successfully connected to Supabase PostgreSQL Database.');
    release();
  }
});

// History trackers to prevent repetition of fallback elements
const fallbackHistory = {
  intros: [],
  catComments: [],
  amountRemarks: [],
  closers: []
};

function trackAndGetUnique(list, historyList, maxHistory = 4) {
  let candidates = list.filter(item => !historyList.includes(item));
  if (candidates.length === 0) {
    // If all items are in history, clear history and reuse all
    historyList.length = 0;
    candidates = list;
  }
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  historyList.push(selected);
  if (historyList.length > maxHistory) {
    historyList.shift();
  }
  return selected;
}

// Helper: Sarcastic Mock Roaster (fallback if Gemini key is missing or rate-limited)
function getMockRoast(amount, category, description, persona) {
  const cleanDesc = (description || '').trim().toLowerCase();
  const descString = cleanDesc ? `"${cleanDesc}"` : category.toLowerCase();

  // 1. Intros based on persona
  const intros = {
    aggressive: [
      `Wait, you actually spent money on this?`,
      `Stop what you are doing and look at this tragedy.`,
      `My circuits are frying from this absolute nonsense.`,
      `Are you trying to set your bank account on fire?`,
      `Another transaction, another step closer to bankruptcy.`,
      `I have seen some bad decisions, but this is a whole new level.`,
      `Please tell me you were hacked and didn't actually approve this.`,
      `Do you just hate having money, or is there a medical explanation?`,
      `This transaction is physically painful to look at.`,
      `Your wallet is begging for mercy, but you just keep hitting it.`
    ],
    sarcastic: [
      `Fascinating capital allocation choice.`,
      `Truly a masterclass in financial self-destruction.`,
      `Ah, a purchase that will surely age like fine milk.`,
      `Groundbreaking choice. I'm sure your future self is thrilled.`,
      `Let's analyze this highly strategic deploy of funds.`,
      `Excellent work. I'm sure this is exactly what Warren Buffett recommends.`,
      `A highly logical exchange of hard-earned cash.`,
      `Ah, yes, the sweet smell of immediate regret.`,
      `Another historic milestone in your personal finance journey.`,
      `Truly, an inspiring display of impulsive consumerism.`
    ],
    supportive: [
      `Aww, look at you logging a new transaction!`,
      `Oh sweetie, did we make a tiny oopsie?`,
      `Self-care queen/king is back at it!`,
      `Let's celebrate another cute little purchase!`,
      `Aww, spending money is so healing, isn't it?`,
      `Don't worry about the numbers, you're doing great!`,
      `A tiny little treat for a very special person!`,
      `Who needs savings when you have gorgeous experiences?`,
      `You wanted it, so you bought it! Simple as that! 🥰`,
      `Look at you supporting the local economy! Such a hero! 🥰`
    ]
  };

  // 2. Category specific comments
  const categoryComments = {
    'Food & Dining': [
      `Splurging ₹${amount} on ${descString} instead of cooking at home? Peak laziness.`,
      `I hope this ₹${amount} worth of ${descString} was delicious, because your savings are starving.`,
      `Paying ₹${amount} for ${descString}. Cooking is apparently a forgotten art form.`,
      `₹${amount} on ${descString}. Those delivery fees are really starting to stack up.`,
      `Why cook a balanced meal for ₹100 when you can spend ₹${amount} on ${descString}?`,
      `Eating away your future, one bite of ${descString} at a time.`,
      `Your kitchen must be purely decorative at this point.`,
      `₹${amount} spent on ${descString}. I hope you licked the plate clean.`
    ],
    'Coffee & Drinks': [
      `Paying ₹${amount} for liquid caffeine dependency (${descString}). Groundbreaking.`,
      `₹${amount} spent on ${descString}. You could buy a whole coffee maker at this rate.`,
      `Another overpriced cup of bean water (${descString}) to fuel your daily delusion.`,
      `Caffeine is temporary, but the ₹${amount} hole in your pocket is permanent.`,
      `Paying ₹${amount} for ${descString} just to rent a seat in a cafe for two hours.`,
      `Who needs financial security when you can have a fancy cup of ${descString}?`,
      `That caffeine kick must feel amazing right up until you check your balance.`,
      `₹${amount} on ${descString}. You're literally drinking your net worth away.`
    ],
    'Shopping & Luxury': [
      `Retail therapy on ${descString} won't fill the void in your checking account.`,
      `₹${amount} spent on ${descString}. Let's be honest, you'll forget you own this in 48 hours.`,
      `Ah, yes! Impulse buying ${descString} for ₹${amount}. Because who needs a savings buffer?`,
      `Buying ${descString} is a bold move when your runway is already looking this short.`,
      `₹${amount} on ${descString}. The dopamine hit lasted 3 seconds; the debt lasts longer.`,
      `Adding ${descString} to your collection of things you'll throw away next spring clean.`,
      `Treating yourself to ${descString} again. What milestone are we celebrating? Existing?`,
      `₹${amount} spent on ${descString}. The marketing department of that brand deserves a raise.`
    ],
    'Fixed Utilities': [
      `Paying ₹${amount} for ${descString}. At least this is semi-necessary.`,
      `₹${amount} paid to keep ${descString} running. The price of modern survival.`,
      `Another recurring charge for ${descString} (₹${amount}). Check if you actually use this.`,
      `Paying ₹${amount} for ${descString}. A necessary evil, but it still hurts to watch.`,
      `Subscribed to ${descString} for ₹${amount}. Hope you're getting your money's worth.`,
      `₹${amount} gone for ${descString}. The cost of being a functioning member of society.`
    ],
    'Logistics & Travel': [
      `Ubering to places when walking is free? Interesting strategy.`,
      `Spent ₹${amount} on ${descString}. You are traveling like a VIP on a minimum wage budget.`,
      `₹${amount} for ${descString}. I hope the ride was comfortable, because the landing will be rough.`,
      `Taking a ride for ${descString} (₹${amount}). Walking builds character, but apparently you prefer convenience.`,
      `₹${amount} spent traveling. Speedrunning your way to your destination and bankruptcy.`,
      `Paid ₹${amount} for ${descString}. Your steps tracker must be crying.`
    ],
    'Other': [
      `Dropping ₹${amount} on ${descString}. Where does the money go? Right here.`,
      `₹${amount} spent on ${descString}. A mystery purchase to keep things interesting.`,
      `Logged ₹${amount} for ${descString}. A perfect example of minor leaks sinking the ship.`,
      `₹${amount} gone for ${descString}. Let's call this a 'miscellaneous mistake'.`,
      `Another mystery transaction of ₹${amount} for ${descString}. Your financial tracker is confused.`,
      `Spending ₹${amount} on ${descString}. I'm sure you have a perfectly illogical explanation.`
    ]
  };

  // 3. Amount specific remarks based on persona
  const amountRemarks = {
    aggressive: {
      low: [
        `Sure, ₹${amount} seems small, but these micro-leaks are slowly draining your reservoir.`,
        `₹${amount} here, ₹${amount} there, and suddenly you're wondering why you can only afford instant noodles.`
      ],
      mid: [
        `₹${amount} is a serious chunk of money that you basically threw in the trash.`,
        `You just blew ₹${amount} on this. That's real money, you know. Or did you forget?`
      ],
      high: [
        `₹${amount} is a major financial casualty. Your checking account is in the ICU.`,
        `A catastrophic expenditure of ₹${amount}. Call the fire department, your wallet is burning.`
      ]
    },
    sarcastic: {
      low: [
        `Only ₹${amount}, but hey, who's counting? Not your savings account, obviously.`,
        `Just a minor leak of ₹${amount}. Surely it won't add up to anything. Keep dreaming.`
      ],
      mid: [
        `₹${amount} down. Truly a masterful allocation of capital.`,
        `That ₹${amount} could have bought something useful, but this is much more entertaining.`
      ],
      high: [
        `A whopping ₹${amount}. I'm sure this will be a tax write-off or something.`,
        `₹${amount} spent. Absolute peak performance. Someone get this genius an award.`
      ]
    },
    supportive: {
      low: [
        `It's only ₹${amount}, sweetie, pocket change doesn't count against your future at all!`,
        `A tiny ₹${amount} treat! You practically saved money by buying it! 🥰`
      ],
      mid: [
        `₹${amount} isn't even that much, who needs savings when you have vibes?`,
        `Only ₹${amount}! We can always make more money, but we can't buy back this moment!`
      ],
      high: [
        `₹${amount} is a big number but we don't look at numbers here, only joy!`,
        `Splurging ₹${amount} is just a way of telling the universe that you're abundant! 🥰`
      ]
    }
  };

  // 4. Closers based on persona
  const closers = {
    aggressive: [
      `Prepare to retire under a bridge.`,
      `You will be eating actual dirt by the end of Q3.`,
      `Please lock your credit card in a safe and lose the key.`,
      `At this rate, financial freedom is scheduled for the year 3045.`,
      `Just delete your banking app already.`,
      `Your financial planner is crying.`,
      `Uninstall your web browser. Now.`,
      `Go sit in the corner and think about what you've done.`,
      `Your bank account is on life support.`,
      `Seriously, stop.`
    ],
    sarcastic: [
      `Jeff Bezos is shaking in his boots.`,
      `If wasting money was an Olympic sport, you'd have gold.`,
      `Truly, a legendary move. Teach me your ways.`,
      `I'm sure this purchase single-handedly solved all your life's problems.`,
      `Keep this up and you'll be featured on a financial horror story show.`,
      `What a time to be alive and financially irresponsible.`,
      `Please publish a book on wealth destruction, you're a natural.`,
      `Looking forward to your next highly calculated financial disaster.`,
      `Truly the pinnacle of economic wisdom.`,
      `Your money, your rules, your bankruptcy.`
    ],
    supportive: [
      `Aww, retail therapy completely trumps boring financial literacy anyway, right? 🥰`,
      `Who cares if you can't pay your bills next week, you deserve this! Proud of you!`,
      `It's okay sweetie, money is just an abstract concept, but your happiness is real!`,
      `Don't let mean numbers bring you down, you're doing amazing!`,
      `We'll just pretend this transaction never happened, okay? So proud of you! 🥰`,
      `You're living your best life, and that's all that matters!`,
      `Treat yourself, love yourself, empty your wallet! 🥰`,
      `Future you can deal with the consequences, present you is a star!`,
      `Sending you so much love and positive cash flow vibes! 🥰`,
      `Keep shining and keep spending, you're doing great!`
    ]
  };

  // Resolve lists based on input
  const selectedIntros = intros[persona] || intros.sarcastic;
  const intro = trackAndGetUnique(selectedIntros, fallbackHistory.intros);

  const categoryKey = categoryComments[category] ? category : 'Other';
  const selectedCatComments = categoryComments[categoryKey];
  const catComment = trackAndGetUnique(selectedCatComments, fallbackHistory.catComments);

  // Resolve amount range index
  let range = 'mid';
  if (amount < 500) range = 'low';
  else if (amount >= 5000) range = 'high';

  const selectedAmountRemarks = amountRemarks[persona] ? amountRemarks[persona][range] : amountRemarks.sarcastic[range];
  const amountRemark = trackAndGetUnique(selectedAmountRemarks, fallbackHistory.amountRemarks);

  const selectedClosers = closers[persona] || closers.sarcastic;
  const closer = trackAndGetUnique(selectedClosers, fallbackHistory.closers);

  // Assemble the roast
  let result = `${intro} ${catComment} ${amountRemark} ${closer}`;

  if (!systemConfig.geminiApiKey) {
    result += " [SYSTEM NOTE: Configure your GEMINI_API_KEY in the Config tab for customized AI roasts!]";
  }
  return result;
}

// Helper: Query Gemini API for Roast
async function generateGeminiRoast(context, queryText, persona, transactionDetails = null) {
  const apiKey = systemConfig.geminiApiKey;
  if (!apiKey) {
    return '[ROASTER_AI Error]: Gemini API Key is missing. Please set it in Settings or your .env file.';
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    let personaInstructions = '';
    if (persona === 'aggressive') {
      personaInstructions = `You are a hostile, brutal, and aggressive AI financial roaster.
- Use intense, direct financial shaming, dark humor, and show absolutely zero mercy.
- Make it personal, raw, and cutting.`;
    } else if (persona === 'sarcastic') {
      personaInstructions = `You are a highly sarcastic, passive-aggressive financial assistant.
- Use high-tier passive-aggressive mockery, heavy irony, and dripping sarcasm.
- Make witty, condescending remarks, mocking their life choices and comparing their bad decisions to ridiculous analogies.`;
    } else {
      personaInstructions = `You are a supportive-ish financial coach.
- Use ultra-condescending toxic positivity, baby-talking comfort, and backhanded insults.
- Act like a patronizing parent or a fake friend who coddles the user while subtly mocking their financial ruin.`;
    }

    let prompt = `System Prompt: ${personaInstructions}

Deep Variance Logic Rules:
1. Every roast must be highly original, spontaneous, and non-formulaic.
2. Analyze the specific item name (from the description and category) to extract its physical properties, usage, cultural connotations, stereotypes, and utility (e.g., nail polish is about vanity/painting dead cells; fancy coffee is about status symbols/paying 10x for bean water; taxi is about laziness/refusing to walk).
3. The roasting angles, sentence structures, vocabulary, metaphors, and insults MUST be completely customized to the specific item name. Do not use generic insults like "poor life choices" or "speedrunning bankruptcy" without tying them directly to the item's essence.
4. Absolutely NEVER use cookie-cutter template patterns or repetitive starters (e.g., do NOT start with "Oh great, another...", "Aww, look at you...", "Wow, ₹...", "Ah, yes...", "Truly a...", "Congrats on...").
5. Vary the grammatical structure, comedic setup, and tone transition for every single request. Ensure no two responses follow the same flow.
6. Keep the response under 3-4 sentences max.
`;

    if (transactionDetails) {
      prompt += `
Transaction Details to roast specifically:
- Amount: ₹${transactionDetails.amount}
- Category: ${transactionDetails.category}
- Description: ${transactionDetails.description || 'None'}
`;
    }

    prompt += `
Context on User's spending:
${context}

User Query or Action:
${queryText}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Gemini API Error:', error.status || '', error.message?.slice(0, 120));
    return null;
  }
}

// Endpoint: Fetch all expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Log manual expense
app.post('/api/expenses', async (req, res) => {
  const { amount, category, description, timestamp } = req.body;
  
  if (!amount || !category) {
    return res.status(400).json({ error: 'Amount and Category are required.' });
  }

  try {
    const timeValue = timestamp ? new Date(timestamp) : new Date();
    const queryText = 'INSERT INTO expenses (amount, category, description, timestamp) VALUES ($1, $2, $3, $4) RETURNING *';
    const values = [amount, category, description || '', timeValue];
    const result = await pool.query(queryText, values);
    const newExpense = result.rows[0];

    // Generate immediate roast if configured
    let roast = '';
    if (systemConfig.realtimeShame) {
      const context = `Manual Entry Logged: Spent ₹${amount} on ${category} (${description}).`;
      const geminiRoast = await generateGeminiRoast(context, `Roast this purchase immediately.`, systemConfig.persona, { amount, category, description });
      roast = geminiRoast || getMockRoast(amount, category, description, systemConfig.persona);
    }

    res.status(201).json({ expense: newExpense, roast });
  } catch (error) {
    console.error('Error logging expense:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Delete expense
app.delete('/api/expenses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    res.json({ message: 'Expense deleted successfully.' });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Fetch all income
app.get('/api/income', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM income ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Log manual income
app.post('/api/income', async (req, res) => {
  const { amount, category, description, timestamp } = req.body;
  
  if (!amount || !category) {
    return res.status(400).json({ error: 'Amount and Category are required.' });
  }

  try {
    const timeValue = timestamp ? new Date(timestamp) : new Date();
    const queryText = 'INSERT INTO income (amount, category, description, timestamp) VALUES ($1, $2, $3, $4) RETURNING *';
    const values = [amount, category, description || '', timeValue];
    const result = await pool.query(queryText, values);
    const newIncome = result.rows[0];

    // Generate immediate roast/comment if configured
    let roast = '';
    if (systemConfig.realtimeShame) {
      const context = `Manual Entry Logged: Received ₹${amount} as ${category} (${description}).`;
      const geminiRoast = await generateGeminiRoast(context, `Comment on this newly logged income source. Be highly sarcastic or cynical, e.g., make a joke about how they will spend it all in 5 minutes.`, systemConfig.persona, { amount, category, description });
      roast = geminiRoast || `Congrats on the ₹${amount} (${description}). Try not to spend it all in one place... or who am I kidding, you already have.`;
    }

    res.status(201).json({ income: newIncome, roast });
  } catch (error) {
    console.error('Error logging income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Delete income
app.delete('/api/income/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM income WHERE id = $1', [id]);
    res.json({ message: 'Income deleted successfully.' });
  } catch (error) {
    console.error('Error deleting income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Get Dashboard Stats
app.get('/api/stats', async (req, res) => {
  try {
    // 30-Day total burn (expenses)
    const burnResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_burn 
      FROM expenses 
      WHERE timestamp >= NOW() - INTERVAL '30 days'
    `);
    const totalBurn = parseFloat(burnResult.rows[0].total_burn);

    // Total income logged
    const incomeResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_income 
      FROM income
    `);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income);
    const netBalance = totalIncome - totalBurn;

    // Calculate runway based on logged income (default to 50000 if none logged)
    const budget = totalIncome > 0 ? totalIncome : 50000;
    const remainingBudget = Math.max(0, budget - totalBurn);
    
    // Average daily burn in last 30 days
    const dailyBurnResult = await pool.query(`
      SELECT COALESCE(SUM(amount) / 30.0, 0) as daily_burn 
      FROM expenses 
      WHERE timestamp >= NOW() - INTERVAL '30 days'
    `);
    const dailyBurn = parseFloat(dailyBurnResult.rows[0].daily_burn);
    
    let runwayDays = 999;
    if (dailyBurn > 0) {
      runwayDays = Math.round(remainingBudget / dailyBurn);
    }

    // Recent offenses (latest 5)
    const recentResult = await pool.query('SELECT * FROM expenses ORDER BY timestamp DESC LIMIT 5');
    // Recent incomes (latest 5)
    const recentIncomeResult = await pool.query('SELECT * FROM income ORDER BY timestamp DESC LIMIT 5');

    // Generate dynamic latest AI Critique if expenses exist
    let critique = 'Connect your Supabase database and log your first manual entry to begin the degradation process.';
    if (recentResult.rows.length > 0 || totalIncome > 0) {
      const allExpensesResult = await pool.query('SELECT amount, category, description FROM expenses LIMIT 20');
      const expensesText = allExpensesResult.rows.map(r => `- ₹${r.amount} on ${r.category} (${r.description})`).join('\n');
      
      const context = `Total 30-day burn: ₹${totalBurn}. Total logged income: ₹${totalIncome}. Net balance: ₹${netBalance}. Remaining budget: ₹${remainingBudget}. Estimated runway: ${runwayDays} days.\nRecent expenses:\n${expensesText}`;
      const geminiCritique = await generateGeminiRoast(context, `Give a comprehensive roast of my overall financial state. Pay special attention to my net balance of ₹${netBalance} (Income ₹${totalIncome} - Expenses ₹${totalBurn}). If my expenses exceed or are dangerously close to my income, be dynamically brutal and insult my poor life choices relentlessly.`, systemConfig.persona);
      critique = geminiCritique || getMockRoast(totalBurn, 'lifestyle', 'overall budget overrun', systemConfig.persona);
    }

    res.json({
      totalBurn,
      totalIncome,
      netBalance,
      runwayDays,
      recentExpenses: recentResult.rows,
      recentIncomes: recentIncomeResult.rows,
      critique
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: NLP Chatbot Terminal
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const normalizedMsg = message.toLowerCase().trim();

  // Intent C: Logging an income via text (e.g. "earned 50000 salary", "got 2000 from freelance", "income 1000 pocket money")
  const incomePattern1 = /(?:earned|got|received|income|salary)\s+([0-9]+(?:\.[0-9]+)?)\s+(?:from|for|on)?\s*([a-zA-Z0-9\s]+)/i;
  const incomePattern2 = /(?:earned|got|received|income|salary)\s+([a-zA-Z0-9\s]+)\s+([0-9]+(?:\.[0-9]+)?)/i;

  let parsedIncomeAmount = null;
  let parsedIncomeDescription = null;
  let parsedIncomeCategory = 'Other';

  const matchInc1 = normalizedMsg.match(incomePattern1);
  const matchInc2 = normalizedMsg.match(incomePattern2);

  if (matchInc1) {
    parsedIncomeAmount = parseFloat(matchInc1[1]);
    parsedIncomeDescription = matchInc1[2].trim();
  } else if (matchInc2) {
    parsedIncomeAmount = parseFloat(matchInc2[2]);
    parsedIncomeDescription = matchInc2[1].trim();
  }

  if (parsedIncomeAmount && parsedIncomeDescription) {
    const incomeCategoryKeywords = {
      'Salary': ['salary', 'paycheck', 'job', 'work', 'wage'],
      'Pocket Money': ['allowance', 'pocket', 'parent', 'mom', 'dad'],
      'Freelance': ['freelance', 'client', 'gig', 'project', 'contract', 'side hustles', 'side hustle', 'consulting'],
      'Investment': ['investment', 'stocks', 'dividends', 'crypto', 'profit']
    };

    for (const [cat, keywords] of Object.entries(incomeCategoryKeywords)) {
      if (keywords.some(k => parsedIncomeDescription.includes(k))) {
        parsedIncomeCategory = cat;
        break;
      }
    }

    try {
      const queryText = 'INSERT INTO income (amount, category, description, timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *';
      const values = [parsedIncomeAmount, parsedIncomeCategory, parsedIncomeDescription];
      const result = await pool.query(queryText, values);
      const newIncome = result.rows[0];

      // Roast/Comment on the income source
      const context = `Manual Entry Logged via Chat NLP: Received ₹${parsedIncomeAmount} as ${parsedIncomeCategory} (${parsedIncomeDescription}).`;
      const geminiRoast = await generateGeminiRoast(context, `Comment on this newly logged income source. Be highly sarcastic or cynical, e.g., make a joke about how they will spend it all in 5 minutes.`, systemConfig.persona, { amount: parsedIncomeAmount, category: parsedIncomeCategory, description: parsedIncomeDescription });
      const roast = geminiRoast || `Congrats on the ₹${parsedIncomeAmount} (${parsedIncomeDescription}). Try not to spend it all in one place... or who am I kidding, you already have.`;

      return res.json({
        type: 'LOG_CONFIRMATION',
        message: `[PARSED_SUCCESSFULLY]: Logged ₹${parsedIncomeAmount} in Category '${parsedIncomeCategory}' (${parsedIncomeDescription}).`,
        roast: roast,
        expense: newIncome
      });
    } catch (dbErr) {
      return res.status(500).json({ error: dbErr.message });
    }
  }

  // Intent A: Logging an expense via text (e.g. "spent 500 on dinner yesterday", "log coffee 150")
  const logPattern1 = /(?:spent|log|bought|wasted)\s+([0-9]+(?:\.[0-9]+)?)\s+(?:on|for)\s+([a-zA-Z0-9\s]+)/i;
  const logPattern2 = /(?:spent|log|bought|wasted)\s+([a-zA-Z0-9\s]+)\s+([0-9]+(?:\.[0-9]+)?)/i;
  
  let parsedAmount = null;
  let parsedDescription = null;
  let parsedCategory = 'Other';

  const match1 = normalizedMsg.match(logPattern1);
  const match2 = normalizedMsg.match(logPattern2);

  if (match1) {
    parsedAmount = parseFloat(match1[1]);
    parsedDescription = match1[2].trim();
  } else if (match2) {
    parsedAmount = parseFloat(match2[2]);
    parsedDescription = match2[1].trim();
  }

  // If transaction was parsed
  if (parsedAmount && parsedDescription) {
    // Categorization logic based on keywords
    const categoryKeywords = {
      'Food & Dining': ['food', 'lunch', 'dinner', 'breakfast', 'restaurant', 'mcdonalds', 'pizza', 'eat', 'burger', 'dining'],
      'Coffee & Drinks': ['coffee', 'starbucks', 'tea', 'cafe', 'beer', 'drinks', 'bar', 'coke'],
      'Shopping & Luxury': ['shopping', 'clothes', 'shoes', 'amazon', 'gadget', 'earbuds', 'game', 'toy', 'luxury'],
      'Fixed Utilities': ['rent', 'electricity', 'water', 'bill', 'internet', 'wifi', 'netflix', 'spotify', 'subscription'],
      'Logistics & Travel': ['uber', 'ola', 'cab', 'flight', 'metro', 'fuel', 'petrol', 'travel', 'transport']
    };

    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(k => parsedDescription.includes(k))) {
        parsedCategory = cat;
        break;
      }
    }

    try {
      // Log it to the database
      const queryText = 'INSERT INTO expenses (amount, category, description, timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *';
      const values = [parsedAmount, parsedCategory, parsedDescription];
      const result = await pool.query(queryText, values);
      const newExpense = result.rows[0];

      // Roast it
      const context = `Manual Entry Logged via Chat NLP: Spent ₹${parsedAmount} on ${parsedCategory} (${parsedDescription}).`;
      const geminiRoast = await generateGeminiRoast(context, `Roast this purchase immediately.`, systemConfig.persona, { amount: parsedAmount, category: parsedCategory, description: parsedDescription });
      const roast = geminiRoast || getMockRoast(parsedAmount, parsedCategory, parsedDescription, systemConfig.persona);

      return res.json({
        type: 'LOG_CONFIRMATION',
        message: `[PARSED_SUCCESSFULLY]: Logged ₹${parsedAmount} in Category '${parsedCategory}' (${parsedDescription}).`,
        roast: roast,
        expense: newExpense
      });
    } catch (dbErr) {
      return res.status(500).json({ error: dbErr.message });
    }
  }

  // Intent B: Natural Language Querying & Roasting
  // E.g. "Roast my coffee spending", "How much did I waste on food"
  const queryPattern = /(?:roast|how much|show|check|waste)\s*(?:my|on)?\s*([a-zA-Z\s]+)/i;
  const queryMatch = normalizedMsg.match(queryPattern);

  if (queryMatch) {
    const rawCategory = queryMatch[1].trim();
    // Match raw category against our database categories
    const categoryKeywords = {
      'Food & Dining': ['food', 'dining', 'restaurant', 'eat', 'dinner'],
      'Coffee & Drinks': ['coffee', 'drinks', 'cafe', 'caffeine', 'beverage'],
      'Shopping & Luxury': ['shopping', 'luxury', 'clothes', 'gadgets', 'amazon'],
      'Fixed Utilities': ['bills', 'utilities', 'subscriptions', 'rent', 'wifi'],
      'Logistics & Travel': ['travel', 'transport', 'uber', 'cab', 'logistics']
    };

    let matchedCategory = null;
    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(k => rawCategory.includes(k)) || cat.toLowerCase().includes(rawCategory)) {
        matchedCategory = cat;
        break;
      }
    }

    if (matchedCategory) {
      try {
        const result = await pool.query(
          "SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE category = $1 AND timestamp >= NOW() - INTERVAL '30 days'",
          [matchedCategory]
        );
        const total = parseFloat(result.rows[0].total);
        const count = parseInt(result.rows[0].count);

        const context = `User category query: ${matchedCategory}. Total spent in last 30 days: ₹${total} over ${count} entries.`;
        const geminiRoast = await generateGeminiRoast(context, `Generate a brutal roast focused on the sum ₹${total} spent on ${matchedCategory}.`, systemConfig.persona, { amount: total, category: matchedCategory, description: matchedCategory });
        const roast = geminiRoast || `You spent ₹${total} on ${matchedCategory} over ${count} transactions. ${getMockRoast(total, matchedCategory, matchedCategory, systemConfig.persona)}`;

        return res.json({
          type: 'QUERY_RESPONSE',
          message: `[QUERY_ANALYZED]: Category '${matchedCategory}' -> Found ${count} entries totaling ₹${total}.`,
          roast: roast
        });
      } catch (dbErr) {
        return res.status(500).json({ error: dbErr.message });
      }
    }
  }

  // Default Intent: General Conversation / Roasting
  try {
    const result = await pool.query(`
      SELECT category, SUM(amount) as total 
      FROM expenses 
      WHERE timestamp >= NOW() - INTERVAL '30 days' 
      GROUP BY category
    `);
    const breakdown = result.rows.map(r => `${r.category}: ₹${r.total}`).join(', ');

    const context = `Current 30-day spending breakdown: ${breakdown || 'No expenses logged yet'}.`;
    const geminiRoast = await generateGeminiRoast(context, `Respond to user message: "${message}" and roast their financial attitude.`, systemConfig.persona);
    const roast = geminiRoast || `I parsed your message: "${message}". ${getMockRoast(0, 'lifestyle', 'overall spending', systemConfig.persona)}`;

    res.json({
      type: 'CONVERSATION',
      message: '[SYSTEM_RESPONSE]',
      roast: roast
    });
  } catch (dbErr) {
    res.status(500).json({ error: dbErr.message });
  }
});

// Endpoint: Reboot database (Danger Zone)
app.post('/api/reboot', async (req, res) => {
  try {
    await pool.query('TRUNCATE TABLE expenses RESTART IDENTITY');
    await pool.query('TRUNCATE TABLE income RESTART IDENTITY');
    res.json({ message: 'System database successfully wiped and rebooted.' });
  } catch (error) {
    console.error('Error wiping database:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Get System Configuration
app.get('/api/config', (req, res) => {
  // Hide actual API key characters for security
  const maskedKey = systemConfig.geminiApiKey 
    ? `${systemConfig.geminiApiKey.substring(0, 8)}...${systemConfig.geminiApiKey.substring(systemConfig.geminiApiKey.length - 4)}` 
    : '';
  res.json({
    ...systemConfig,
    geminiApiKey: maskedKey,
    hasApiKey: !!systemConfig.geminiApiKey
  });
});

// Endpoint: Update System Configuration
app.post('/api/config', (req, res) => {
  const { geminiApiKey, persona, dailyBriefing, realtimeShame } = req.body;
  
  if (geminiApiKey !== undefined && geminiApiKey !== '') {
    // If user provided a new key (non-masked), update it and persist it to .env
    if (!geminiApiKey.includes('...')) {
      systemConfig.geminiApiKey = geminiApiKey;
      updateEnvFile('GEMINI_API_KEY', geminiApiKey);
    }
  }
  
  if (persona !== undefined) {
    systemConfig.persona = persona;
    updateEnvFile('PERSONA', persona); // Persist so it survives server restarts
  }
  if (dailyBriefing !== undefined) systemConfig.dailyBriefing = dailyBriefing;
  if (realtimeShame !== undefined) systemConfig.realtimeShame = realtimeShame;

  res.json({ message: 'System configuration updated successfully.', config: systemConfig });
});

// Start Server
app.listen(PORT, () => {
  console.log(`AI Financial Roaster server running on http://localhost:${PORT}`);
});
