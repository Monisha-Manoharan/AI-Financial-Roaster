const express = require('express');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
require('dotenv').config();



const app = express();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory configuration store for dynamic API Key / Persona settings
// Reads persona from .env so it persists across server restarts
let systemConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  
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

// Test Database Connection & Run Migrations
pool.connect(async (err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
  } else {
    console.log('Successfully connected to Supabase PostgreSQL Database.');
    try {
      console.log('Running database schema migrations...');
      // Add user_id and roast columns if missing
      await client.query(`
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
        ALTER TABLE income ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
        ALTER TABLE expenses ADD COLUMN IF NOT EXISTS roast TEXT;
        ALTER TABLE income ADD COLUMN IF NOT EXISTS roast TEXT;
      `);
      // Fix any broken identity records where provider_id is UUID instead of email
      await client.query(`
        UPDATE auth.identities i
        SET provider_id = u.email
        FROM auth.users u
        WHERE i.user_id = u.id
          AND i.provider = 'email'
          AND i.provider_id != u.email;
      `);
      console.log('Database schema migrations completed successfully.');
    } catch (migErr) {
      console.error('Migration failed:', migErr);
    } finally {
      release();
    }
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


async function getUserPersona(userId) {
  try {
    const res = await pool.query('SELECT persona FROM user_preferences WHERE user_id = $1', [userId]);
    return res.rows.length > 0 ? res.rows[0].persona : 'aggressive';
  } catch (err) {
    console.error('Error fetching user persona:', err);
    return 'aggressive';
  }
}

// Middleware: Verify Supabase Session Token (JWT)
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization header.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const response = await fetch(`${process.env.SUPABASE_URL || 'https://zppsylijcayivvchtwqz.supabase.co'}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY || ''
      }
    });
    if (!response.ok) {
      return res.status(401).json({ error: 'Unauthorized: Invalid session token.' });
    }
    const userData = await response.json();
    req.userId = userData.id; // Store verified Supabase user ID
    next();
  } catch (err) {
    console.error('Auth verification failed:', err);
    res.status(401).json({ error: 'Unauthorized: Auth server verification failed.' });
  }
}

// Endpoint: Fetch all expenses
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY timestamp DESC', [req.userId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Log manual expense
app.post('/api/expenses', requireAuth, async (req, res) => {
  const { amount, category, description, timestamp } = req.body;
  
  if (!amount || !category) {
    return res.status(400).json({ error: 'Amount and Category are required.' });
  }

  try {
    const timeValue = timestamp ? new Date(timestamp) : new Date();

    // Generate immediate roast if configured
    let roast = '';
    if (systemConfig.realtimeShame) {
      const context = `Manual Entry Logged: Spent ₹${amount} on ${category} (${description}).`;
      const geminiRoast = await generateGeminiRoast(context, `Roast this purchase immediately.`, await getUserPersona(req.userId), { amount, category, description });
      roast = geminiRoast || getMockRoast(amount, category, description, await getUserPersona(req.userId));
    }

    const queryText = 'INSERT INTO expenses (amount, category, description, timestamp, user_id, roast) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
    const values = [amount, category, description || '', timeValue, req.userId, roast];
    const result = await pool.query(queryText, values);
    const newExpense = result.rows[0];

    res.status(201).json({ expense: newExpense, roast });
  } catch (error) {
    console.error('Error logging expense:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Delete expense
app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING *', [id, req.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Expense not found or unauthorized.' });
    }
    res.json({ message: 'Expense deleted successfully.' });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Fetch all income
app.get('/api/income', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM income WHERE user_id = $1 ORDER BY timestamp DESC', [req.userId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Log manual income
app.post('/api/income', requireAuth, async (req, res) => {
  const { amount, category, description, timestamp } = req.body;
  
  if (!amount || !category) {
    return res.status(400).json({ error: 'Amount and Category are required.' });
  }

  try {
    const timeValue = timestamp ? new Date(timestamp) : new Date();

    // Generate immediate roast/comment if configured
    let roast = '';
    if (systemConfig.realtimeShame) {
      const context = `Manual Entry Logged: Received ₹${amount} as ${category} (${description}).`;
      const geminiRoast = await generateGeminiRoast(context, `Comment on this newly logged income source. Be highly sarcastic or cynical, e.g., make a joke about how they will spend it all in 5 minutes.`, await getUserPersona(req.userId), { amount, category, description });
      roast = geminiRoast || `Congrats on the ₹${amount} (${description}). Try not to spend it all in one place... or who am I kidding, you already have.`;
    }

    const queryText = 'INSERT INTO income (amount, category, description, timestamp, user_id, roast) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
    const values = [amount, category, description || '', timeValue, req.userId, roast];
    const result = await pool.query(queryText, values);
    const newIncome = result.rows[0];

    res.status(201).json({ income: newIncome, roast });
  } catch (error) {
    console.error('Error logging income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Delete income
app.delete('/api/income/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM income WHERE id = $1 AND user_id = $2 RETURNING *', [id, req.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Income not found or unauthorized.' });
    }
    res.json({ message: 'Income deleted successfully.' });
  } catch (error) {
    console.error('Error deleting income:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Get Dashboard Stats
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    // 30-Day total burn (expenses)
    const burnResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_burn 
      FROM expenses 
      WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '30 days'
    `, [req.userId]);
    const totalBurn = parseFloat(burnResult.rows[0].total_burn);

    // Total income logged
    const incomeResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_income 
      FROM income
      WHERE user_id = $1
    `, [req.userId]);
    const totalIncome = parseFloat(incomeResult.rows[0].total_income);
    const netBalance = totalIncome - totalBurn;

    // Calculate runway based on logged income (default to 50000 if none logged)
    const budget = totalIncome > 0 ? totalIncome : 50000;
    const remainingBudget = Math.max(0, budget - totalBurn);
    
    // Average daily burn in last 30 days
    const dailyBurnResult = await pool.query(`
      SELECT COALESCE(SUM(amount) / 30.0, 0) as daily_burn 
      FROM expenses 
      WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '30 days'
    `, [req.userId]);
    const dailyBurn = parseFloat(dailyBurnResult.rows[0].daily_burn);
    
    let runwayDays = 999;
    if (dailyBurn > 0) {
      runwayDays = Math.round(remainingBudget / dailyBurn);
    }

    // Recent offenses (latest 5)
    const recentResult = await pool.query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 5', [req.userId]);
    // Recent incomes (latest 5)
    const recentIncomeResult = await pool.query('SELECT * FROM income WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 5', [req.userId]);

    // Generate dynamic latest AI Critique if expenses exist
    let critique = 'Connect your Supabase database and log your first manual entry to begin the degradation process.';
    if (recentResult.rows.length > 0 || totalIncome > 0) {
      const allExpensesResult = await pool.query('SELECT amount, category, description FROM expenses WHERE user_id = $1 LIMIT 20', [req.userId]);
      const expensesText = allExpensesResult.rows.map(r => `- ₹${r.amount} on ${r.category} (${r.description})`).join('\n');
      
      const context = `Total 30-day burn: ₹${totalBurn}. Total logged income: ₹${totalIncome}. Net balance: ₹${netBalance}. Remaining budget: ₹${remainingBudget}. Estimated runway: ${runwayDays} days.\nRecent expenses:\n${expensesText}`;
      const geminiCritique = await generateGeminiRoast(context, `Give a comprehensive roast of my overall financial state. Pay special attention to my net balance of ₹${netBalance} (Income ₹${totalIncome} - Expenses ₹${totalBurn}). If my expenses exceed or are dangerously close to my income, be dynamically brutal and insult my poor life choices relentlessly.`, await getUserPersona(req.userId));
      critique = geminiCritique || getMockRoast(totalBurn, 'lifestyle', 'overall budget overrun', await getUserPersona(req.userId));
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
app.post('/api/chat', requireAuth, async (req, res) => {
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
      // Roast/Comment on the income source
      const context = `Manual Entry Logged via Chat NLP: Received ₹${parsedIncomeAmount} as ${parsedIncomeCategory} (${parsedIncomeDescription}).`;
      const geminiRoast = await generateGeminiRoast(context, `Comment on this newly logged income source. Be highly sarcastic or cynical, e.g., make a joke about how they will spend it all in 5 minutes.`, await getUserPersona(req.userId), { amount: parsedIncomeAmount, category: parsedIncomeCategory, description: parsedIncomeDescription });
      const roast = geminiRoast || `Congrats on the ₹${parsedIncomeAmount} (${parsedIncomeDescription}). Try not to spend it all in one place... or who am I kidding, you already have.`;

      const queryText = 'INSERT INTO income (amount, category, description, timestamp, user_id, roast) VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING *';
      const values = [parsedIncomeAmount, parsedIncomeCategory, parsedIncomeDescription, req.userId, roast];
      const result = await pool.query(queryText, values);
      const newIncome = result.rows[0];

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
      // Roast it
      const context = `Manual Entry Logged via Chat NLP: Spent ₹${parsedAmount} on ${parsedCategory} (${parsedDescription}).`;
      const geminiRoast = await generateGeminiRoast(context, `Roast this purchase immediately.`, await getUserPersona(req.userId), { amount: parsedAmount, category: parsedCategory, description: parsedDescription });
      const roast = geminiRoast || getMockRoast(parsedAmount, parsedCategory, parsedDescription, await getUserPersona(req.userId));

      // Log it to the database
      const queryText = 'INSERT INTO expenses (amount, category, description, timestamp, user_id, roast) VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING *';
      const values = [parsedAmount, parsedCategory, parsedDescription, req.userId, roast];
      const result = await pool.query(queryText, values);
      const newExpense = result.rows[0];

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
          "SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE user_id = $2 AND category = $1 AND timestamp >= NOW() - INTERVAL '30 days'",
          [matchedCategory, req.userId]
        );
        const total = parseFloat(result.rows[0].total);
        const count = parseInt(result.rows[0].count);

        const context = `User category query: ${matchedCategory}. Total spent in last 30 days: ₹${total} over ${count} entries.`;
        const geminiRoast = await generateGeminiRoast(context, `Generate a brutal roast focused on the sum ₹${total} spent on ${matchedCategory}.`, await getUserPersona(req.userId), { amount: total, category: matchedCategory, description: matchedCategory });
        const roast = geminiRoast || `You spent ₹${total} on ${matchedCategory} over ${count} transactions. ${getMockRoast(total, matchedCategory, matchedCategory, await getUserPersona(req.userId))}`;

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
      WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '30 days' 
      GROUP BY category
    `, [req.userId]);
    const breakdown = result.rows.map(r => `${r.category}: ₹${r.total}`).join(', ');

    const context = `Current 30-day spending breakdown: ${breakdown || 'No expenses logged yet'}.`;
    const geminiRoast = await generateGeminiRoast(context, `Respond to user message: "${message}" and roast their financial attitude.`, await getUserPersona(req.userId));
    const roast = geminiRoast || `I parsed your message: "${message}". ${getMockRoast(0, 'lifestyle', 'overall spending', await getUserPersona(req.userId))}`;

    res.json({
      type: 'CONVERSATION',
      message: '[SYSTEM_RESPONSE]',
      roast: roast
    });
  } catch (dbErr) {
    res.status(500).json({ error: dbErr.message });
  }
});


// Endpoint: Get User Preferences
app.get('/api/user-preferences', requireAuth, async (req, res) => {
  try {
    const persona = await getUserPersona(req.userId);
    res.json({ persona });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Update User Preferences
app.post('/api/user-preferences', requireAuth, async (req, res) => {
  const { persona } = req.body;
  if (!persona) return res.status(400).json({ error: 'Persona is required' });
  try {
    await pool.query(
      'INSERT INTO user_preferences (user_id, persona) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET persona = EXCLUDED.persona',
      [req.userId, persona]
    );
    res.json({ message: 'Preferences updated successfully.', persona });
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Reboot database (Danger Zone)
app.post('/api/reboot', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE user_id = $1', [req.userId]);
    await pool.query('DELETE FROM income WHERE user_id = $1', [req.userId]);
    res.json({ message: 'System database successfully wiped and rebooted.' });
  } catch (error) {
    console.error('Error wiping database:', error);
    res.status(500).json({ error: error.message });
  }
});


// Endpoint: Expose Supabase public credentials
app.get('/api/supabase-config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || 'https://zppsylijcayivvchtwqz.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

// Endpoint: Admin-level signup — creates a pre-confirmed user directly in auth.users
// Email is auto-generated from username if not supplied: username@bankrupt.com
// This bypasses Supabase email rate limits entirely (no confirmation email sent)
app.post('/api/admin-signup', async (req, res) => {
  const { password, username, email } = req.body;
  if (!password || !username) {
    return res.status(400).json({ error: 'username and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  let internalEmail;
  if (email) {
    const trimmedEmail = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    internalEmail = trimmedEmail;
  } else {
    // Auto-generate a clean internal email from username
    const safeUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    internalEmail = `${safeUsername}@bankrupt.com`;
  }

  try {
    // Check if username already taken
    const usernameCheck = await pool.query(
      "SELECT id FROM auth.users WHERE LOWER(raw_user_meta_data->>'username') = LOWER($1) LIMIT 1",
      [username.trim()]
    );
    if (usernameCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken. Choose a different one.' });
    }

    // Check if generated email already exists (shouldn't, but safety check)
    const existCheck = await pool.query(
      'SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [internalEmail]
    );
    if (existCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken. Choose a different one.' });
    }

    // Hash the password with bcrypt (cost 10, matching Supabase default)
    const encryptedPassword = await bcrypt.hash(password, 10);
    const userId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    const metaData = JSON.stringify({ username: username.trim() });

    // Insert directly into auth.users with email pre-confirmed
    await pool.query(
      `INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change, is_super_admin
      ) VALUES (
        $1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        $2, $3, NOW(), $4::jsonb, '{"provider":"email","providers":["email"]}'::jsonb,
        $5, $5, '', '', '', '', false
      )`,
      [userId, internalEmail, encryptedPassword, metaData, now]
    );

    // Insert into auth.identities (required for Supabase signInWithPassword to work)
    // provider_id MUST equal the email for the email provider
    await pool.query(
      `INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      ) VALUES (
        $1, $1, $2, $3::jsonb, 'email', NOW(), $4, $4
      )`,
      [userId, internalEmail, JSON.stringify({ sub: userId, email: internalEmail }), now]
    );

    res.json({ message: 'User created successfully.', userId, email: internalEmail });
  } catch (error) {
    console.error('Error in admin-signup:', error);
    res.status(500).json({ error: 'Failed to create account: ' + error.message });
  }
});

// Endpoint: Confirm an existing unconfirmed user's email
app.post('/api/confirm-user', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }
  try {
    const result = await pool.query(
      'UPDATE auth.users SET email_confirmed_at = NOW() WHERE LOWER(email) = LOWER($1) AND email_confirmed_at IS NULL RETURNING id, email',
      [email.trim()]
    );
    res.json({ message: 'User confirmed successfully', rows: result.rows });
  } catch (error) {
    console.error('Error confirming user:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Resolve a username from auth.users metadata to an email address
app.post('/api/resolve-username', authLimiter, async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  try {
    const queryText = "SELECT email FROM auth.users WHERE LOWER(raw_user_meta_data->>'username') = LOWER($1) AND email_confirmed_at IS NOT NULL LIMIT 1";
    const result = await pool.query(queryText, [username.trim()]);
    if (result.rows.length > 0) {
      res.json({ email: result.rows[0].email });
    } else {
      res.status(404).json({ error: 'Username not found in the identity matrix.' });
    }
  } catch (error) {
    console.error('Error resolving username:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`AI Financial Roaster server running on http://localhost:${PORT}`);
});
