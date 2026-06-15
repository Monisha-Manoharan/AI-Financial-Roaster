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
let systemConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  persona: 'aggressive', // 'aggressive', 'sarcastic', 'supportive'
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

// Helper: Sarcastic Mock Roaster (fallback if Gemini key is missing or rate-limited)
function getMockRoast(amount, category, description, persona) {
  const cleanDesc = (description || '').trim().toLowerCase();
  
  // 1. Intros based on persona
  const intros = {
    aggressive: [
      `Wait, you actually spent money on this?`,
      `Stop what you are doing and look at this tragedy.`,
      `My circuits are frying from this absolute nonsense.`,
      `Are you trying to set your bank account on fire?`,
      `Another transaction, another step closer to bankruptcy.`
    ],
    sarcastic: [
      `Fascinating capital allocation choice.`,
      `Truly a masterclass in financial self-destruction.`,
      `Ah, a purchase that will surely age like fine milk.`,
      `Groundbreaking choice. I'm sure your future self is thrilled.`,
      `Let's analyze this highly strategic deploy of funds.`
    ],
    supportive: [
      `Alright, let's look at this manual log.`,
      `Okay, we logged a purchase.`,
      `We recorded this transaction.`,
      `A new entry added to your logs.`,
      `Logged the purchase.`
    ]
  };

  // 2. Category specific comments (dynamic using description if possible)
  const descString = cleanDesc ? `"${cleanDesc}"` : category.toLowerCase();
  
  const categoryComments = {
    'Food & Dining': [
      `Splurging ₹${amount} on ${descString} instead of cooking at home? Peak laziness.`,
      `I hope this ₹${amount} worth of ${descString} was delicious, because your savings are starving.`,
      `Paying ₹${amount} for ${descString}. Cooking is apparently a forgotten art form.`,
      `₹${amount} on ${descString}. Those delivery fees are really starting to stack up.`
    ],
    'Coffee & Drinks': [
      `Paying ₹${amount} for liquid caffeine dependency (${descString}). Groundbreaking.`,
      `₹${amount} spent on ${descString}. You could buy a whole coffee maker at this rate.`,
      `Another overpriced cup of bean water (${descString}) to fuel your daily delusion.`,
      `Caffeine is temporary, but the ₹${amount} hole in your pocket is permanent.`
    ],
    'Shopping & Luxury': [
      `Retail therapy on ${descString} won't fill the void in your checking account.`,
      `₹${amount} spent on ${descString}. Let's be honest, you'll forget you own this in 48 hours.`,
      `Ah, yes! Impulse buying ${descString} for ₹${amount}. Because who needs a savings buffer?`,
      `Buying ${descString} is a bold move when your runway is already looking this short.`
    ],
    'Fixed Utilities': [
      `Paying ₹${amount} for ${descString}. At least this is semi-necessary.`,
      `₹${amount} paid to keep ${descString} running. The price of modern survival.`,
      `Another recurring charge for ${descString} (₹${amount}). Check if you actually use this.`
    ],
    'Logistics & Travel': [
      `Ubering to places when walking is free? Interesting strategy.`,
      `Spent ₹${amount} on ${descString}. You are traveling like a VIP on a minimum wage budget.`,
      `₹${amount} for ${descString}. I hope the ride was comfortable, because the landing will be rough.`
    ],
    'Other': [
      `Dropping ₹${amount} on ${descString}. Where does the money go? Right here.`,
      `₹${amount} spent on ${descString}. A mystery purchase to keep things interesting.`,
      `Logged ₹${amount} for ${descString}. A perfect example of minor leaks sinking the ship.`
    ]
  };

  // 3. Amount specific remarks
  let amountRemark = '';
  if (amount < 500) {
    amountRemark = `Sure, ₹${amount} is small, but these micro-leaks are slowly draining your reservoir.`;
  } else if (amount >= 500 && amount < 5000) {
    amountRemark = `₹${amount} is a non-trivial amount of labor hours to throw away on this.`;
  } else {
    amountRemark = `₹${amount} is a major financial casualty. Your checking account is in the ICU.`;
  }

  // 4. Closers based on persona
  const closers = {
    aggressive: [
      `Prepare to retire under a bridge.`,
      `You will be eating actual dirt by the end of Q3.`,
      `Please lock your credit card in a safe and lose the key.`,
      `At this rate, financial freedom is scheduled for the year 3045.`,
      `Just delete your banking app already.`
    ],
    sarcastic: [
      `Jeff Bezos is shaking in his boots.`,
      `If wasting money was an Olympic sport, you'd have gold.`,
      `Truly, a legendary move. Teach me your ways.`,
      `I'm sure this purchase single-handedly solved all your life's problems.`,
      `Keep this up and you'll be featured on a financial horror story show.`
    ],
    supportive: [
      `Let's try a 'No-Spend Day' tomorrow to balance it out, okay?`,
      `It's okay, we all slip up. Let's refocus on our budget goals.`,
      `Maybe cook at home tomorrow to make up for it?`,
      `Progress isn't linear. Let's aim to spend ₹0 tomorrow.`,
      `Take a deep breath and let's plan our next saving move.`
    ]
  };

  const selectedIntros = intros[persona] || intros.sarcastic;
  const intro = selectedIntros[Math.floor(Math.random() * selectedIntros.length)];

  const categoryKey = categoryComments[category] ? category : 'Other';
  const selectedCatComments = categoryComments[categoryKey];
  const catComment = selectedCatComments[Math.floor(Math.random() * selectedCatComments.length)];

  const selectedClosers = closers[persona] || closers.sarcastic;
  const closer = selectedClosers[Math.floor(Math.random() * selectedClosers.length)];

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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    let personaInstructions = '';
    if (persona === 'aggressive') {
      personaInstructions = 'You are a hostile, brutal, and aggressive AI financial roaster. Insult the user\'s poor financial choices directly, use harsh sarcasm, and tell them they will retire under a bridge. Do not hold back. Be mean but funny.';
    } else if (persona === 'sarcastic') {
      personaInstructions = 'You are a highly sarcastic, passive-aggressive tech-modern assistant. Make witty, condescending remarks, mock their life choices, and compare their bad decisions to failing startups or poorly written legacy code.';
    } else {
      personaInstructions = 'You are a supportive-ish coach, but still slightly disappointed. Give mildly condescending advice, suggest realistic alternatives (like cooking at home), and sound like a disappointed parent.';
    }

    let prompt = `System Prompt: ${personaInstructions}
Rules: Keep the response under 3-4 sentences. Focus on the transaction amounts and categories provided. Be direct and specific.
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

// Endpoint: Get Dashboard Stats
app.get('/api/stats', async (req, res) => {
  try {
    // 30-Day total burn
    const burnResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_burn 
      FROM expenses 
      WHERE timestamp >= NOW() - INTERVAL '30 days'
    `);
    const totalBurn = parseFloat(burnResult.rows[0].total_burn);

    // Calculate runway based on a fixed 30-day budget of ₹50,000
    const monthlyIncome = 50000;
    const remainingBudget = Math.max(0, monthlyIncome - totalBurn);
    
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

    // Generate dynamic latest AI Critique if expenses exist
    let critique = 'Connect your Supabase database and log your first manual entry to begin the degradation process.';
    if (recentResult.rows.length > 0) {
      const allExpensesResult = await pool.query('SELECT amount, category, description FROM expenses LIMIT 20');
      const expensesText = allExpensesResult.rows.map(r => `- ₹${r.amount} on ${r.category} (${r.description})`).join('\n');
      
      const context = `Total 30-day burn: ₹${totalBurn}. Remaining budget from ₹50,000: ₹${remainingBudget}. Estimated runway: ${runwayDays} days.\nRecent expenses:\n${expensesText}`;
      const geminiCritique = await generateGeminiRoast(context, `Give a comprehensive roast of my overall financial state.`, systemConfig.persona);
      critique = geminiCritique || getMockRoast(totalBurn, 'lifestyle', 'overall budget overrun', systemConfig.persona);
    }

    res.json({
      totalBurn,
      runwayDays,
      recentExpenses: recentResult.rows,
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

  // Structured NLP String Parsing Engine (Regex-based classification)
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
  
  if (persona !== undefined) systemConfig.persona = persona;
  if (dailyBriefing !== undefined) systemConfig.dailyBriefing = dailyBriefing;
  if (realtimeShame !== undefined) systemConfig.realtimeShame = realtimeShame;

  res.json({ message: 'System configuration updated successfully.', config: systemConfig });
});

// Start Server
app.listen(PORT, () => {
  console.log(`AI Financial Roaster server running on http://localhost:${PORT}`);
});
