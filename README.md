# 💸 AI Financial Roaster

```
     ___  ___   ___ _                   _       _   ___                 _            
    / _ \|_ _| | __(_)_ _  __ _ _ _  __(_) __ _| | | _ \___  __ _ ___ _| |_ ___ _ _ 
   | (_) || |  | _|| | ' \/ _` | ' \/ _| |/ _` | | |   / _ \/ _` (_-<  _|  _/ -_) '_|
   |_/ \_\___| |_| |_|_||_\__,_|_||_\__|_|\__,_|_| |_|_\___/\__,_/__/\__|\__\___|_|  
                                                                                    
   [SYSTEM]: INITIALIZING BRUTAL ACCOUNTABILITY ENGINE... [OK]
   [STATUS]: MONITORING LIFESTYLE INFLATION... [ACTIVE]
```

> **Warning:** This is not your friendly neighborhood budgeting app. There are no pastel-colored pie charts or gentle reminders. The **AI Financial Roaster** is a locally-run, aggressive, and highly sarcastic AI chatbot designed to roast your terrible spending choices. It reads manual expense entries stored locally in SQLite, runs structured NLP string parsing for text queries, and evaluates your financial life with absolute disdain.

---

## 🛠️ System Overview

The **AI Financial Roaster** leverages a lightweight, local-first stack to deliver real-time financial degradation.

```
       +-------------------------------------------------------------+
       |                  Terminal UI / User Query                   |
       +-------------------------------------------------------------+
                                      |
                                      v
       +-------------------------------------------------------------+
       |             Structured NLP String Parsing Engine             |
       +-------------------------------------------------------------+
                                      |
                                      v
       +-------------------------------------------------------------+
       |       SQLite Database       |      Gemini AI Roaster        |
       |     (Local Expense Logs)    |     (Sarcastic Feedback)      |
       +-------------------------------------------------------------+
```

### Key Capabilities
*   **Zero-Cloud Privacy (SQLite):** Your financial shame remains local. All manual expense entries are stored in a local SQLite database file, keeping your data safe from cloud leaks (but not from the AI's judgment).
*   **Structured NLP Parsing:** Type natural questions like `"Roast my Uber rides since last Tuesday"` or `"How much did I waste on coffee?"`. Our custom NLP parsing maps sentences directly to structured SQLite queries.
*   **Aggressive AI Core:** Powered by the Gemini API via Google AI Studio, custom-tuned to drop witty, sarcastic, and direct roasts based on your spending thresholds and weekly categories.

---

## 💻 Interactive Terminal Demo

Here is a typical transcript of the terminal interface running in `--roast` mode:

```bash
$ python ai_financial_roaster.py --query "Roast my dining out this week"

[sys] Parsing query: "dining out this week" -> Category: Dining, Period: Last 7 Days
[sys] Querying local SQLite database... Found 6 entries totaling $184.50.
[sys] Feeding context to Gemini API...
[ai] Roast Analysis:
     "Oh look, another $184.50 spent on dining out this week. I didn't realize 
      your kitchen was decorated with police tape. You logged 6 separate manual entries 
      for restaurants—did your stove break, or does cooking require too many brain cells? 
      Keep this up and your net worth will scale slower than a legacy database on dial-up."
```

---

## 🚀 Getting Started

Follow these steps to run the roaster locally on your system.

### Prerequisites

*   **Python 3.10+**
*   **SQLite3**
*   **Google AI Studio API Key** (Set as `GEMINI_API_KEY` environment variable)

### Installation & Run

1.  **Clone the Repository:**
    ```bash
    $ git clone https://github.com/<your-username>/AI-Financial-Roaster.git
    $ cd AI-Financial-Roaster
    ```

2.  **Install Dependencies:**
    ```bash
    $ pip install -r requirements.txt
    ```

3.  **Initialize the Database:**
    ```bash
    $ python ai_financial_roaster.py --init-db
    ```

4.  **Log a Manual Expense:**
    ```bash
    $ python ai_financial_roaster.py --log "Spent $15.50 on fancy coffee at Starbucks"
    [sys] Successfully logged: $15.50 in category 'Coffee'
    [ai] "A $15.50 coffee? I hope that bean was hand-watered with tears of venture capitalists. Keep investing in liquid caffeine, I'm sure it pays great dividends."
    ```

5.  **Run a Natural Language Roast Query:**
    ```bash
    $ python ai_financial_roaster.py --query "Roast my subscriptions"
    ```

---

## 📊 Database Schema (SQLite)

The database schema is designed to be minimal and high-performance.

| Table | Column | Type | Description |
| :--- | :--- | :--- | :--- |
| **expenses** | `id` | INTEGER (PK) | Unique auto-incrementing ID |
| | `amount` | REAL | Transaction amount |
| | `category` | TEXT | Parsed expense category (e.g., Dining, Coffee, Subscriptions) |
| | `description`| TEXT | Raw user text entry |
| | `timestamp` | DATETIME | Time of manual entry |

---

## 🎭 AI Roast Personalities

You can adjust the roast aggressiveness using the `--aggression` flag:

*   `--aggression 1` (Passive-Aggressive): Heavy sighing, disappointed statistics.
*   `--aggression 2` (Sarcastic - Default): Witty remarks, tech-industry comparisons.
*   `--aggression 3` (Financial Doom): Direct insults to your financial future, queries whether you plan to retire under a bridge.

---

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
