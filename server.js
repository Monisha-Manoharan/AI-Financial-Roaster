const express = require('express');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
require('dotenv').config();

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

// Helper: Sarcastic Mock Roaster (fallback if Gemini key is missing)
function getMockRoast(amount, category, description, persona) {
  const roasts = {
    aggressive: [
      `₹${amount} on ${category}? Are you actively trying to go broke, or does financial stability scare you?`,
      `Oh look, another manually logged transaction for ${description} (₹${amount}). I didn't realize you had a money printing press in your basement.`,
      `Log details: ₹${amount} spent on ${category}. My algorithms suggest you will be subsisting on actual dirt by Q3 if you keep this up.`
    ],
    sarcastic: [
      `Wow, ₹${amount} on ${category}. Groundbreaking capital allocation. Truly, a mastermind at work.`,
      `Ah, yes! ₹${amount} spent on ${description}. Because who needs a retirement fund when you can have instant gratification?`,
      `₹${amount} for ${category} logged. I'm sure this purchase will single-handedly solve all your life's problems.`
    ],
    supportive: [
      `Logged ₹${amount} on ${category}. It's okay, we all make mistakes. Maybe just... cook at home tomorrow?`,
      `₹${amount} spent on ${description}. Let's try to do a 'No-Spend Day' tomorrow to balance it out, okay?`,
      `Manual entry recorded: ₹${amount} for ${category}. Progress is progress, even if your bank account is weeping.`
    ]
  };
  
  const selectedRoasts = roasts[persona] || roasts.sarcastic;
  const randomIndex = Math.floor(Math.random() * selectedRoasts.length);
  return selectedRoasts[randomIndex] + " [SYSTEM NOTE: Configure your GEMINI_API_KEY in the Config tab for customized AI roasts!]";
}

// Helper: Query Gemini API for Roast
async function generateGeminiRoast(context, queryText, persona, transactionDetails = null) {
  const apiKey = systemConfig.geminiApiKey;
  if (!apiKey) {
    return null;
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
    // If Gemini fails for any reason (e.g. rate limit, quota, invalid API key), return null
    // so that the server code automatically fails over to the dynamic mock roaster
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
    const roast = geminiRoast || `I parsed your message: "${message}". If you wanted me to log a transaction, write e.g., "spent 500 on coffee". Otherwise, configure your Gemini API Key in Settings to talk to my actual brain!`;

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
    // If user provided a new key (non-masked), update it
    if (!geminiApiKey.includes('...')) {
      systemConfig.geminiApiKey = geminiApiKey;
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
