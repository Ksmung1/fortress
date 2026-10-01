"use client";

import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BarChart3, CalendarClock,
  AlertTriangle, BrainCircuit, Check, ChevronRight, Cloud, CloudOff, Download, Eye, EyeOff, FileJson, Gauge, Landmark,
  LayoutDashboard, List, LogIn, LogOut, Menu, Plus, ReceiptText, Scale, ShieldCheck, Sparkles,
  Target, Trash2, TrendingDown, TrendingUp, Upload, Wallet, X, Pencil, PiggyBank, Repeat2,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut,
} from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Page = "Command Centre" | "Record" | "Ledger" | "Cash Flow" | "Plan" | "Obligations" | "Audit";
type TransactionType = "Income" | "Expense" | "Transfer";
type Account = { id: string; name: string; openingBalance: number };
type Transaction = { id: string; date: string; type: TransactionType; amount: number; business: string; category: string; description: string; notes: string; accountId: string; toAccountId?: string };
type Obligation = { id: string; name: string; amount: number; due: string; paid: boolean; accountId?: string; category?: string; source?: string; paidTransactionId?: string };
type Decision = { id: string; title: string; notes: string; date: string };
type Budget = { id: string; category: string; limit: number };
type Goal = { id: string; name: string; target: number; saved: number };
type Recurring = { id: string; description: string; amount: number; type: "Income" | "Expense"; category: string; source?: string; accountId: string; day: number };
type FinanceData = { openingBalance: number | null; accounts: Account[]; transactions: Transaction[]; obligations: Obligation[]; decisions: Decision[]; budgets: Budget[]; goals: Goal[]; recurring: Recurring[]; categories: string[]; sources: string[] };
type Insight = { tone: "good" | "warn" | "info"; title: string; text: string };

const START_DATE = "2026-10-01";
const STORAGE_KEY = "fortress-finance-v1";
const DEFAULT_ACCOUNT = "main-bank";
const defaultAccounts: Account[] = [
  { id: DEFAULT_ACCOUNT, name: "Main bank", openingBalance: 0 },
  { id: "cash", name: "Cash", openingBalance: 0 },
  { id: "upi", name: "UPI / wallet", openingBalance: 0 },
];
const emptyData: FinanceData = { openingBalance: null, accounts: defaultAccounts, transactions: [], obligations: [], decisions: [], budgets: [], goals: [], recurring: [], categories: [], sources: [] };

const nav = [
  { name: "Command Centre" as Page, short: "Home", icon: LayoutDashboard },
  { name: "Record" as Page, short: "Record", icon: Plus },
  { name: "Ledger" as Page, short: "Ledger", icon: List },
  { name: "Cash Flow" as Page, short: "Cash", icon: BarChart3 },
  { name: "Plan" as Page, short: "Plan", icon: Target },
  { name: "Obligations" as Page, short: "Bills", icon: CalendarClock },
  { name: "Audit" as Page, short: "Audit", icon: ShieldCheck },
];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const prettyDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const today = () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const currentMonth = () => today().slice(0, 7);

function normalizeData(value: Partial<FinanceData> & { openingBalance?: number | null }): FinanceData {
  const accounts = Array.isArray(value.accounts) && value.accounts.length
    ? value.accounts
    : defaultAccounts.map((account, index) => ({ ...account, openingBalance: index === 0 && typeof value.openingBalance === "number" ? value.openingBalance : 0 }));
  const transactions = Array.isArray(value.transactions) ? value.transactions.map(transaction => ({ ...transaction, accountId: transaction.accountId || accounts[0].id })) : [];
  const savedCategories = Array.isArray(value.categories) ? value.categories : [];
  const savedSources = Array.isArray(value.sources) ? value.sources : [];
  return {
    openingBalance: typeof value.openingBalance === "number" ? value.openingBalance : null,
    accounts,
    transactions,
    obligations: Array.isArray(value.obligations) ? value.obligations : [],
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    budgets: Array.isArray(value.budgets) ? value.budgets : [],
    goals: Array.isArray(value.goals) ? value.goals : [],
    recurring: Array.isArray(value.recurring) ? value.recurring : [],
    categories: [...new Set([...savedCategories, ...transactions.map(transaction => transaction.category).filter(category => category && category !== "Transfer")])],
    sources: [...new Set([...savedSources, ...transactions.map(transaction => transaction.business).filter(Boolean)])],
  };
}

function getAccountBalances(data: FinanceData) {
  const balances = Object.fromEntries(data.accounts.map(account => [account.id, account.openingBalance])) as Record<string, number>;
  for (const transaction of data.transactions) {
    if (!(transaction.accountId in balances)) balances[transaction.accountId] = 0;
    if (transaction.type === "Income") balances[transaction.accountId] += transaction.amount;
    if (transaction.type === "Expense") balances[transaction.accountId] -= transaction.amount;
    if (transaction.type === "Transfer") {
      balances[transaction.accountId] -= transaction.amount;
      if (transaction.toAccountId) balances[transaction.toAccountId] = (balances[transaction.toAccountId] || 0) + transaction.amount;
    }
  }
  return balances;
}

function buildInsights(data: FinanceData, month: string, cash: number): Insight[] {
  const transactions = data.transactions.filter(transaction => transaction.date.startsWith(month));
  const income = transactions.filter(transaction => transaction.type === "Income").reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenses = transactions.filter(transaction => transaction.type === "Expense").reduce((sum, transaction) => sum + transaction.amount, 0);
  const categorySpend = transactions.filter(transaction => transaction.type === "Expense").reduce<Record<string, number>>((result, transaction) => {
    result[transaction.category] = (result[transaction.category] || 0) + transaction.amount;
    return result;
  }, {});
  const insights: Insight[] = [];
  if (!transactions.length) return [{ tone: "info", title: "Start with today", text: "Record your first income or expense. I need a few real entries before I can spot useful patterns." }];
  if (cash < 0) insights.push({ tone: "warn", title: "Your recorded cash is negative", text: "Check account opening balances and missing income before making optional purchases." });
  if (income > 0) {
    const savingsRate = (income - expenses) / income;
    if (savingsRate < 0) insights.push({ tone: "warn", title: "You spent more than you received", text: `Outflow is ${money(expenses - income)} above income this month. Pause non-essential spending and check upcoming bills.` });
    else if (savingsRate < .1) insights.push({ tone: "warn", title: "Savings margin is thin", text: `You are keeping about ${Math.round(savingsRate * 100)}% of income. Try to protect at least 10% first.` });
    else if (savingsRate >= .2) insights.push({ tone: "good", title: "Healthy savings pace", text: `You are keeping about ${Math.round(savingsRate * 100)}% of this month's income. Consider moving part of it to a goal.` });
  } else if (expenses > 0) insights.push({ tone: "warn", title: "Spending without recorded income", text: "Add any income you received this month so the picture is accurate." });
  const top = Object.entries(categorySpend).sort((a, b) => b[1] - a[1])[0];
  if (top && expenses > 0 && top[1] / expenses >= .35) insights.push({ tone: "info", title: `${top[0]} is your biggest spend`, text: `It accounts for ${Math.round(top[1] / expenses * 100)}% of this month's expenses (${money(top[1])}). Check whether that feels intentional.` });
  for (const budget of data.budgets) {
    const used = categorySpend[budget.category] || 0;
    if (used > budget.limit) insights.push({ tone: "warn", title: `${budget.category} budget exceeded`, text: `You are ${money(used - budget.limit)} over your ${money(budget.limit)} monthly limit.` });
    else if (budget.limit > 0 && used / budget.limit >= .8) insights.push({ tone: "info", title: `${budget.category} budget nearly used`, text: `${money(budget.limit - used)} remains for this month.` });
  }
  const now = new Date(`${today()}T00:00:00`);
  const soon = data.obligations.filter(item => !item.paid).filter(item => {
    const days = (new Date(`${item.due}T00:00:00`).getTime() - now.getTime()) / 86400000;
    return days >= 0 && days <= 7;
  });
  if (soon.length) insights.push({ tone: "warn", title: `${soon.length} payment${soon.length > 1 ? "s" : ""} due soon`, text: `${money(soon.reduce((sum, item) => sum + item.amount, 0))} is due within seven days. Keep that cash available.` });
  if (!data.budgets.length) insights.push({ tone: "info", title: "Give spending a boundary", text: "Add one or two monthly category budgets in Plan. Start with the categories that vary most." });
  return insights.slice(0, 5);
}

export default function Fortress() {
  const [page, setPage] = useState<Page>("Command Centre");
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [data, setData] = useState<FinanceData>(emptyData);
  const [ready, setReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [cloudStatus, setCloudStatus] = useState<"local" | "syncing" | "synced" | "error">("local");
  const importRef = useRef<HTMLInputElement>(null);
  const cloudLoaded = useRef(false);
  const applyingRemoteData = useRef(false);
  const latestData = useRef(data);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setData(normalizeData(JSON.parse(saved)));
      } catch { /* keep a safe empty ledger */ }
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    latestData.current = data;
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, ready]);

  useEffect(() => {
    if (!ready) return;
    let detachSnapshot = () => {};
    const detachAuth = onAuthStateChanged(auth, nextUser => {
      setAuthReady(true);
      detachSnapshot();
      setUser(nextUser);
      cloudLoaded.current = false;
      if (!nextUser) { setCloudStatus("local"); return; }
      setCloudStatus("syncing");
      const stateRef = doc(db, "users", nextUser.uid, "finance", "state");
      detachSnapshot = onSnapshot(stateRef, snapshot => {
        if (snapshot.exists()) {
          const remote = snapshot.data() as Partial<FinanceData>;
          const normalized = normalizeData(remote);
          if (JSON.stringify(normalized) !== JSON.stringify(latestData.current)) {
            applyingRemoteData.current = true;
            setData(normalized);
          }
          cloudLoaded.current = true;
          setCloudStatus("synced");
        } else {
          setDoc(stateRef, { ...latestData.current, updatedAt: serverTimestamp() })
            .then(() => { cloudLoaded.current = true; setCloudStatus("synced"); })
            .catch(() => setCloudStatus("error"));
        }
      }, () => setCloudStatus("error"));
    }, () => { setAuthReady(true); setCloudStatus("error"); });
    return () => { detachSnapshot(); detachAuth(); };
  }, [ready]);

  useEffect(() => {
    if (!ready || !user || !cloudLoaded.current) return;
    if (applyingRemoteData.current) {
      applyingRemoteData.current = false;
      return;
    }
    setCloudStatus("syncing");
    const timer = window.setTimeout(() => {
      setDoc(doc(db, "users", user.uid, "finance", "state"), { ...data, updatedAt: serverTimestamp() })
        .then(() => setCloudStatus("synced"))
        .catch(() => setCloudStatus("error"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [data, ready, user]);

  const totals = useMemo(() => {
    const monthly = data.transactions.filter(transaction => transaction.date.startsWith(selectedMonth));
    const income = monthly.filter(t => t.type === "Income").reduce((sum, t) => sum + t.amount, 0);
    const expenses = monthly.filter(t => t.type === "Expense").reduce((sum, t) => sum + t.amount, 0);
    const unpaid = data.obligations.filter(o => !o.paid).reduce((sum, o) => sum + o.amount, 0);
    const accountBalances = getAccountBalances(data);
    const cash = Object.values(accountBalances).reduce((sum, balance) => sum + balance, 0);
    return { income, expenses, unpaid, net: income - expenses, cash, accountBalances, monthly };
  }, [data, selectedMonth]);
  const insights = useMemo(() => buildInsights(data, selectedMonth, totals.cash), [data, selectedMonth, totals.cash]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function go(next: Page, preserveEdit = false) {
    if (next === "Record" && !preserveEdit) setEditingTransaction(null);
    setPage(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 2, startDate: START_DATE, exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fortress-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Backup downloaded");
  }

  async function importData(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.transactions) || !Array.isArray(parsed.obligations) || !Array.isArray(parsed.decisions)) throw new Error();
      setData(normalizeData(parsed));
      notify("Backup restored");
    } catch { notify("That backup file is not valid"); }
    if (importRef.current) importRef.current.value = "";
  }

  const currentNav = nav.find(item => item.name === page)!;

  if (!authReady) return <div className="auth-loading"><div className="brand-mark">F.</div><b>FORTRESS</b><span>Securing your financial workspace…</span></div>;
  if (!user) return <AuthModal user={null} status={cloudStatus} onClose={() => {}} notify={notify} required />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">F.</div>
          <div><strong>FORTRESS</strong><span>Financial command centre</span></div>
          <button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>
        <nav className="side-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {nav.map(({ name, short, icon: Icon }) => (
            <button key={name} className={page === name ? "active" : ""} onClick={() => go(name)}>
              <Icon size={18} strokeWidth={1.8} /><span>{name === "Command Centre" ? "Dashboard" : short}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="privacy-dot" /> {user ? "Private cloud sync active" : "Data stays on this device"}
          <small>PK THOMTE · INR ₹</small>
        </div>
      </aside>

      {menuOpen && <button className="backdrop" onClick={() => setMenuOpen(false)} aria-label="Close menu" />}

      <main>
        <header className="topbar">
          <div className="mobile-title"><button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={22} /></button><div><b>FORTRESS</b><span>{currentNav.short}</span></div></div>
          <label className="period"><span>Viewing month</span><input aria-label="Viewing month" type="month" value={selectedMonth} onChange={event => setSelectedMonth(event.target.value)} /></label>
          <div className="header-actions">
            <button className={`button secondary compact cloud-button ${cloudStatus}`} onClick={() => setAuthOpen(true)} title={user?.email ?? "Enable private cloud sync"}>
              {cloudStatus === "error" ? <CloudOff size={16} /> : <Cloud size={16} />}
              {user ? cloudStatus === "error" ? "Sync issue" : "Synced" : "Sign in"}
            </button>
            <button className="button secondary compact" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
            <button className="button compact" onClick={exportData}><Download size={16} /> Backup</button>
            <input ref={importRef} hidden type="file" accept="application/json" onChange={e => importData(e.target.files?.[0])} />
          </div>
        </header>

        <div className="page-wrap">
          {page === "Command Centre" && <Dashboard data={data} totals={totals} insights={insights} month={selectedMonth} go={go} />}
          {page === "Record" && <Record accounts={data.accounts} savedCategories={data.categories} savedSources={data.sources} initial={editingTransaction} onCancel={() => { setEditingTransaction(null); go("Ledger"); }} onSave={tx => { setData(d => ({ ...d, transactions: editingTransaction ? d.transactions.map(item => item.id === tx.id ? tx : item) : [...d.transactions, tx], categories: tx.type === "Transfer" || d.categories.some(item => item.toLowerCase() === tx.category.toLowerCase()) ? d.categories : [...d.categories, tx.category], sources: tx.type === "Transfer" || d.sources.some(item => item.toLowerCase() === tx.business.toLowerCase()) ? d.sources : [...d.sources, tx.business] })); setEditingTransaction(null); go("Ledger"); notify(editingTransaction ? "Transaction updated" : "Transaction recorded"); }} />}
          {page === "Ledger" && <Ledger transactions={data.transactions} accounts={data.accounts} month={selectedMonth} onEdit={transaction => { setEditingTransaction(transaction); go("Record", true); }} onDelete={id => setData(d => ({ ...d, transactions: d.transactions.filter(t => t.id !== id) }))} go={go} />}
          {page === "Cash Flow" && <CashFlow totals={totals} transactions={data.transactions} accounts={data.accounts} month={selectedMonth} go={go} />}
          {page === "Plan" && <Plan data={data} setData={setData} month={selectedMonth} notify={notify} />}
          {page === "Obligations" && <Obligations items={data.obligations} accounts={data.accounts} savedCategories={data.categories} savedSources={data.sources} onChange={(items, transaction, removeTransactionId) => setData(d => { const categories = [...d.categories]; const sources = [...d.sources]; for (const item of items) { if (item.category && !categories.some(value => value.toLowerCase() === item.category!.toLowerCase())) categories.push(item.category); if (item.source && !sources.some(value => value.toLowerCase() === item.source!.toLowerCase())) sources.push(item.source); } return { ...d, obligations: items, transactions: transaction ? [...d.transactions, transaction] : removeTransactionId ? d.transactions.filter(item => item.id !== removeTransactionId) : d.transactions, categories, sources }; })} />}
          {page === "Audit" && <Audit data={data} setData={setData} exportData={exportData} importClick={() => importRef.current?.click()} notify={notify} />}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {nav.slice(0, 5).map(({ name, short, icon: Icon }) => <button key={name} className={page === name ? "active" : ""} onClick={() => go(name)}><Icon size={20} /><span>{short}</span></button>)}
      </nav>
      {authOpen && <AuthModal user={user} status={cloudStatus} onClose={() => setAuthOpen(false)} notify={notify} />}
      {toast && <div className="toast"><Check size={17} /> {toast}</div>}
    </div>
  );
}

function PageIntro({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: React.ReactNode }) {
  return <div className="page-intro"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{text}</p></div>{action}</div>;
}

function Dashboard({ data, totals, insights, month, go }: { data: FinanceData; totals: { income: number; expenses: number; unpaid: number; net: number; cash: number }; insights: Insight[]; month: string; go: (p: Page) => void }) {
  const recent = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const monthLabel = new Date(`${month}-02T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const cards = [
    { label: "Money available", value: money(totals.cash), note: "Across all accounts", icon: Wallet, tone: "purple" },
    { label: `${monthLabel} income`, value: money(totals.income), note: "Confirmed entries", icon: TrendingUp, tone: "green" },
    { label: `${monthLabel} expenses`, value: money(totals.expenses), note: "Confirmed entries", icon: TrendingDown, tone: "red" },
    { label: "Unpaid obligations", value: money(totals.unpaid), note: `${data.obligations.filter(o => !o.paid).length} items outstanding`, icon: CalendarClock, tone: "amber" },
  ];
  return <>
    <PageIntro eyebrow="PRIVATE FINANCIAL OS / 01" title="Command Centre" text="A clear view of money received, money spent, and what needs attention." action={<button className="button" onClick={() => go("Record")}><Plus size={17} /> Record transaction</button>} />
    <section className="metric-grid">{cards.map(({ label, value, note, icon: Icon, tone }) => <article className="metric-card" key={label}><div className={`metric-icon ${tone}`}><Icon size={19} /></div><p>{label}</p><h2>{value}</h2><span>{note}</span></article>)}</section>
    <div className="dashboard-grid">
      <section className="card activity-card"><div className="card-head"><div><p className="eyebrow">Recent activity</p><h2>Financial activity</h2></div><span className="count">{data.transactions.length}</span></div>
        {recent.length === 0 ? <Empty icon={ReceiptText} title="No real transactions recorded" text="Your financial history starts with your first actual entry." action="Record first transaction" onClick={() => go("Record")} /> : <div className="activity-list">{recent.map(t => <TransactionRow key={t.id} transaction={t} accounts={data.accounts} />)}<button className="text-button" onClick={() => go("Ledger")}>View complete ledger <ChevronRight size={15} /></button></div>}
      </section>
      <section className="card coach-card"><div className="coach-title"><div><BrainCircuit size={20} /></div><span><p className="eyebrow">On-device smart coach</p><h2>Your money check-in</h2></span></div><div className="insight-list">{insights.map((insight, index) => <article className={`insight ${insight.tone}`} key={`${insight.title}-${index}`}><span>{insight.tone === "warn" ? <AlertTriangle size={16} /> : insight.tone === "good" ? <Check size={16} /> : <Sparkles size={16} />}</span><div><b>{insight.title}</b><p>{insight.text}</p></div></article>)}</div><small>Calculated privately from your records. No AI API or data sharing.</small></section>
    </div>
  </>;
}

function Record({ accounts, savedCategories, savedSources, initial, onSave, onCancel }: { accounts: Account[]; savedCategories: string[]; savedSources: string[]; initial: Transaction | null; onSave: (tx: Transaction) => void; onCancel: () => void }) {
  const [type, setType] = useState<TransactionType>(initial?.type || "Expense");
  const [amount, setAmount] = useState(initial?.amount.toString() || "");
  const [date, setDate] = useState(initial?.date || today());
  const [business, setBusiness] = useState(initial?.type === "Transfer" ? "" : initial?.business || "");
  const [category, setCategory] = useState(initial?.type === "Transfer" ? "" : initial?.category || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [accountId, setAccountId] = useState(initial?.accountId || accounts[0]?.id || DEFAULT_ACCOUNT);
  const [toAccountId, setToAccountId] = useState(initial?.toAccountId || accounts.find(account => account.id !== accountId)?.id || "");
  function submit(e: FormEvent) { e.preventDefault(); if (+amount <= 0 || !description.trim() || (type !== "Transfer" && (!category.trim() || !business.trim())) || (type === "Transfer" && (!toAccountId || toAccountId === accountId))) return; onSave({ id: initial?.id || uid(), type, amount: +amount, date, business: type === "Transfer" ? "Own accounts" : business.trim(), category: type === "Transfer" ? "Transfer" : category.trim(), description: description.trim(), notes: notes.trim(), accountId, ...(type === "Transfer" ? { toAccountId } : {}) }); }
  const typeOptions = [{ value: "Income" as const, label: "Money received", icon: ArrowDownLeft }, { value: "Expense" as const, label: "Money spent", icon: ArrowUpRight }, { value: "Transfer" as const, label: "Own-account transfer", icon: ArrowLeftRight }];
  return <>
    <PageIntro eyebrow="DAILY INPUT / 02" title={initial ? "Edit transaction" : "Quick financial update"} text="Record the real movement once, with the account and category it belongs to." />
    <form className="card form-card" onSubmit={submit}>
      <div className="field full"><label>Transaction type</label><div className="type-picker">{typeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={type === value ? "active" : ""} onClick={() => setType(value)}><Icon size={19} /><span>{label}</span></button>)}</div></div>
      <Field label="Amount (₹)"><input type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Enter actual amount" required /></Field>
      <Field label="Date"><input type="date" value={date} onChange={e => setDate(e.target.value)} required /></Field>
      <Field label={type === "Transfer" ? "From account" : "Account used"}><select value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>
      {type === "Transfer" ? <Field label="To account"><select value={toAccountId} onChange={e => setToAccountId(e.target.value)} required><option value="">Choose account</option>{accounts.filter(account => account.id !== accountId).map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field> : <><Field label="Category"><input list="saved-categories" value={category} onChange={e => setCategory(e.target.value)} placeholder="Type a category" required /><datalist id="saved-categories">{savedCategories.map(item => <option value={item} key={item} />)}</datalist></Field><Field label={type === "Income" ? "Income source" : "Paid to / purpose"}><input list="saved-sources" value={business} onChange={e => setBusiness(e.target.value)} placeholder={type === "Income" ? "e.g. Salary, client, tuition" : "e.g. Shop, landlord, personal"} required /><datalist id="saved-sources">{savedSources.map(item => <option value={item} key={item} />)}</datalist></Field></>}
      <Field label="Description / reference" full><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What was this transaction for?" required /></Field>
      <Field label="Notes (optional)" full><textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Receipt reference, account details, context…" /></Field>
      <div className="form-note full"><ShieldCheck size={18} /> Synced privately to your account and included in downloadable backups.</div>
      <div className="form-actions full">{initial && <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>}<button className="button submit-button" type="submit"><Plus size={18} /> {initial ? "Update transaction" : "Save transaction"}</button></div>
    </form>
  </>;
}

function Ledger({ transactions, accounts, month, onEdit, onDelete, go }: { transactions: Transaction[]; accounts: Account[]; month: string; onEdit: (transaction: Transaction) => void; onDelete: (id: string) => void; go: (p: Page) => void }) {
  const [filter, setFilter] = useState<"All" | TransactionType>("All");
  const [query, setQuery] = useState("");
  const shown = [...transactions].filter(t => t.date.startsWith(month) && (filter === "All" || t.type === filter) && `${t.description} ${t.business} ${t.category}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date));
  return <>
    <PageIntro eyebrow="SOURCE OF TRUTH / 03" title="Transactions ledger" text="Every recorded financial event, searchable and clearly classified." action={<button className="button" onClick={() => go("Record")}><Plus size={17} /> Add entry</button>} />
    <section className="card ledger-card"><div className="ledger-tools"><div className="filter-pills">{(["All", "Income", "Expense", "Transfer"] as const).map(f => <button className={filter === f ? "active" : ""} onClick={() => setFilter(f)} key={f}>{f}</button>)}</div><input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ledger…" /></div>
      {shown.length === 0 ? <Empty icon={FileJson} title="No transactions this month" text="Change the viewing month or add your first real transaction." action="Add transaction" onClick={() => go("Record")} /> : <div className="ledger-list">{shown.map(t => <div className="ledger-entry" key={t.id}><TransactionRow transaction={t} accounts={accounts} /><div className="entry-meta"><span>{t.category}</span>{t.notes && <span>{t.notes}</span>}<button className="edit-entry" onClick={() => onEdit(t)} aria-label={`Edit ${t.description}`}><Pencil size={14} /> Edit</button><button className="delete" onClick={() => onDelete(t.id)} aria-label={`Delete ${t.description}`}><Trash2 size={15} /> Delete</button></div></div>)}</div>}
    </section>
  </>;
}

function CashFlow({ totals, transactions, accounts, month, go }: { totals: { income: number; expenses: number; net: number; cash: number; accountBalances: Record<string, number> }; transactions: Transaction[]; accounts: Account[]; month: string; go: (p: Page) => void }) {
  const max = Math.max(totals.income, totals.expenses, 1);
  const byCategory = useMemo(() => Object.entries(transactions.filter(t => t.date.startsWith(month) && t.type === "Expense").reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.category]: (acc[t.category] || 0) + t.amount }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5), [transactions, month]);
  return <>
    <PageIntro eyebrow="LIQUIDITY / 04" title="Cash flow" text="Actual recorded movement only. Future income is never assumed." />
    <div className="cash-grid"><section className="card cash-summary"><p className="eyebrow">Available now</p><h2>{money(totals.cash)}</h2><p>Calculated across your accounts from opening balances and every recorded movement.</p><button className="text-button" onClick={() => go("Audit")}>Manage accounts <ChevronRight size={15} /></button><hr />{accounts.map(account => <div className="cash-total" key={account.id}><span>{account.name}</span><b className={(totals.accountBalances[account.id] || 0) < 0 ? "negative" : ""}>{money(totals.accountBalances[account.id] || 0)}</b></div>)}<div className="cash-total"><span>This month&apos;s net movement</span><b className={totals.net < 0 ? "negative" : "positive"}>{money(totals.net)}</b></div></section>
      <section className="card flow-chart"><div className="card-head"><div><p className="eyebrow">Movement comparison</p><h2>Money in vs. money out</h2></div></div><div className="bar-row"><span>Inflows</span><div><i className="income-bar" style={{ width: `${totals.income ? Math.max(8, totals.income / max * 100) : 0}%` }} /></div><b>{money(totals.income)}</b></div><div className="bar-row"><span>Outflows</span><div><i className="expense-bar" style={{ width: `${totals.expenses ? Math.max(8, totals.expenses / max * 100) : 0}%` }} /></div><b>{money(totals.expenses)}</b></div></section>
      <section className="card category-card"><p className="eyebrow">Expense control</p><h2>Top spending categories</h2>{byCategory.length ? byCategory.map(([category, amount]) => <div className="category-row" key={category}><span>{category}</span><b>{money(amount)}</b></div>) : <p className="muted">No expense data recorded yet.</p>}</section>
    </div>
  </>;
}

function Obligations({ items, accounts, savedCategories, savedSources, onChange }: { items: Obligation[]; accounts: Account[]; savedCategories: string[]; savedSources: string[]; onChange: (items: Obligation[], transaction?: Transaction, removeTransactionId?: string) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState(""); const [due, setDue] = useState(today()); const [accountId, setAccountId] = useState(accounts[0]?.id || DEFAULT_ACCOUNT); const [category, setCategory] = useState(""); const [source, setSource] = useState("");
  function submit(event: FormEvent) { event.preventDefault(); if (!name.trim() || !category.trim() || !source.trim() || +amount <= 0) return; onChange([...items, { id: uid(), name: name.trim(), amount: +amount, due, paid: false, accountId, category: category.trim(), source: source.trim() }]); setName(""); setAmount(""); setCategory(""); setSource(""); }
  function togglePaid(obligation: Obligation) {
    if (obligation.paid) { onChange(items.map(item => item.id === obligation.id ? { ...item, paid: false, paidTransactionId: undefined } : item), undefined, obligation.paidTransactionId); return; }
    const transactionId = uid();
    const transaction: Transaction = { id: transactionId, date: today(), type: "Expense", amount: obligation.amount, business: obligation.source || obligation.name, category: obligation.category || "Bills", description: obligation.name, notes: "Created when bill was marked paid", accountId: obligation.accountId || accounts[0].id };
    onChange(items.map(item => item.id === obligation.id ? { ...item, paid: true, paidTransactionId: transactionId } : item), transaction);
  }
  return <><PageIntro eyebrow="COMMITMENT CONTROL / 06" title="Bills & liabilities" text="See what is due. Paying a bill automatically records the expense, so it is never missed." />
    <div className="two-column"><form className="card compact-form" onSubmit={submit}><h2>Add bill or obligation</h2><Field label="Name" full><input value={name} onChange={event => setName(event.target.value)} placeholder="Rent, EMI, supplier..." required /></Field><Field label="Amount (₹)" full><input type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0" required /></Field><Field label="Category" full><input list="bill-categories" value={category} onChange={event => setCategory(event.target.value)} placeholder="Type a category" required /><datalist id="bill-categories">{savedCategories.map(item => <option value={item} key={item} />)}</datalist></Field><Field label="Paid to / purpose" full><input list="bill-sources" value={source} onChange={event => setSource(event.target.value)} placeholder="Type a name or purpose" required /><datalist id="bill-sources">{savedSources.map(item => <option value={item} key={item} />)}</datalist></Field><Field label="Due date" full><input type="date" value={due} onChange={event => setDue(event.target.value)} required /></Field><Field label="Pay from" full><select value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><button className="button full" type="submit"><Plus size={17} /> Add obligation</button></form>
      <section className="stack">{items.length === 0 ? <div className="card"><Empty icon={CalendarClock} title="Nothing due yet" text="Add bills, EMIs, supplier payments, or another real commitment." /></div> : [...items].sort((a, b) => a.due.localeCompare(b.due)).map(obligation => <article className={`card obligation ${obligation.paid ? "paid" : ""}`} key={obligation.id}><div className="obligation-icon"><CalendarClock size={20} /></div><div className="obligation-body"><span>{obligation.paid ? "Paid and recorded" : `Due ${prettyDate(obligation.due)}`}</span><h3>{obligation.name}</h3></div><b>{money(obligation.amount)}</b><div className="obligation-actions"><button className="button secondary compact" onClick={() => togglePaid(obligation)}>{obligation.paid ? "Undo payment" : "Pay & record"}</button><button className="icon-button danger" onClick={() => onChange(items.filter(item => item.id !== obligation.id))}><Trash2 size={17} /></button></div></article>)}</section>
    </div></>;
}

function Plan({ data, setData, month, notify }: { data: FinanceData; setData: React.Dispatch<React.SetStateAction<FinanceData>>; month: string; notify: (message: string) => void }) {
  const [budgetCategory, setBudgetCategory] = useState("");
  const [budgetLimit, setBudgetLimit] = useState("");
  const [goalName, setGoalName] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [recurringDescription, setRecurringDescription] = useState("");
  const [recurringAmount, setRecurringAmount] = useState("");
  const [recurringType, setRecurringType] = useState<"Income" | "Expense">("Expense");
  const [recurringCategory, setRecurringCategory] = useState("");
  const [recurringSource, setRecurringSource] = useState("");
  const monthlySpend = data.transactions.filter(transaction => transaction.date.startsWith(month) && transaction.type === "Expense").reduce<Record<string, number>>((result, transaction) => ({ ...result, [transaction.category]: (result[transaction.category] || 0) + transaction.amount }), {});
  function addBudget(event: FormEvent) { event.preventDefault(); if (!budgetCategory.trim() || +budgetLimit <= 0) return; const category = budgetCategory.trim(); setData(current => ({ ...current, budgets: [...current.budgets.filter(item => item.category.toLowerCase() !== category.toLowerCase()), { id: uid(), category, limit: +budgetLimit }], categories: current.categories.some(item => item.toLowerCase() === category.toLowerCase()) ? current.categories : [...current.categories, category] })); setBudgetCategory(""); setBudgetLimit(""); notify("Monthly budget saved"); }
  function addGoal(event: FormEvent) { event.preventDefault(); if (!goalName.trim() || +goalTarget <= 0) return; setData(current => ({ ...current, goals: [...current.goals, { id: uid(), name: goalName.trim(), target: +goalTarget, saved: 0 }] })); setGoalName(""); setGoalTarget(""); notify("Savings goal added"); }
  function addRecurring(event: FormEvent) { event.preventDefault(); if (!recurringDescription.trim() || !recurringCategory.trim() || !recurringSource.trim() || +recurringAmount <= 0) return; const category = recurringCategory.trim(); const source = recurringSource.trim(); setData(current => ({ ...current, recurring: [...current.recurring, { id: uid(), description: recurringDescription.trim(), amount: +recurringAmount, type: recurringType, category, source, accountId: current.accounts[0].id, day: new Date().getDate() }], categories: current.categories.some(item => item.toLowerCase() === category.toLowerCase()) ? current.categories : [...current.categories, category], sources: current.sources.some(item => item.toLowerCase() === source.toLowerCase()) ? current.sources : [...current.sources, source] })); setRecurringDescription(""); setRecurringAmount(""); setRecurringCategory(""); setRecurringSource(""); notify("Recurring item saved"); }
  function recordRecurring(item: Recurring) { const date = `${month}-${String(Math.min(item.day, 28)).padStart(2, "0")}`; const marker = `Recurring template: ${item.id}`; if (data.transactions.some(transaction => transaction.date.startsWith(month) && transaction.notes === marker)) { notify("This recurring item is already recorded for the month"); return; } setData(current => ({ ...current, transactions: [...current.transactions, { id: uid(), date, type: item.type, amount: item.amount, business: item.source || item.description, category: item.category, description: item.description, notes: marker, accountId: item.accountId }] })); notify("Recurring transaction added"); }
  return <><PageIntro eyebrow="SIMPLE MONEY PLAN / 05" title="Plan your money" text="Set a few useful limits, build savings, and make repeat transactions faster." />
    <div className="plan-grid">
      <section className="card plan-section"><div className="section-icon purple"><Gauge size={19} /></div><h2>Monthly budgets</h2><p className="muted">Use limits only for categories you want to control.</p><form className="mini-form" onSubmit={addBudget}><input list="plan-categories" value={budgetCategory} onChange={event => setBudgetCategory(event.target.value)} placeholder="Type a category" required /><datalist id="plan-categories">{data.categories.map(category => <option value={category} key={category} />)}</datalist><input aria-label="Budget amount" type="number" min="1" value={budgetLimit} onChange={event => setBudgetLimit(event.target.value)} placeholder="Monthly limit" required /><button className="button" type="submit">Add</button></form><div className="plan-list">{data.budgets.map(budget => { const used = monthlySpend[budget.category] || 0; const percent = Math.min(100, budget.limit ? used / budget.limit * 100 : 0); return <article key={budget.id}><div><b>{budget.category}</b><span>{money(used)} of {money(budget.limit)}</span></div><div className="progress"><i className={used > budget.limit ? "over" : ""} style={{ width: `${percent}%` }} /></div><button className="icon-button danger" onClick={() => setData(current => ({ ...current, budgets: current.budgets.filter(item => item.id !== budget.id) }))}><Trash2 size={15} /></button></article>; })}</div></section>
      <section className="card plan-section"><div className="section-icon green"><PiggyBank size={19} /></div><h2>Savings goals</h2><p className="muted">Update the saved amount whenever you move money aside.</p><form className="mini-form" onSubmit={addGoal}><input value={goalName} onChange={event => setGoalName(event.target.value)} placeholder="Goal name" required /><input aria-label="Goal target" type="number" min="1" value={goalTarget} onChange={event => setGoalTarget(event.target.value)} placeholder="Target" required /><button className="button" type="submit">Add</button></form><div className="plan-list">{data.goals.map(goal => <article key={goal.id}><div><b>{goal.name}</b><span>{money(goal.saved)} of {money(goal.target)}</span></div><input aria-label={`Saved for ${goal.name}`} type="number" min="0" value={goal.saved} onChange={event => setData(current => ({ ...current, goals: current.goals.map(item => item.id === goal.id ? { ...item, saved: +event.target.value } : item) }))} /><button className="icon-button danger" onClick={() => setData(current => ({ ...current, goals: current.goals.filter(item => item.id !== goal.id) }))}><Trash2 size={15} /></button></article>)}</div></section>
      <section className="card plan-section wide"><div className="section-icon amber"><Repeat2 size={19} /></div><h2>Recurring money</h2><p className="muted">Keep templates for salary, rent, EMI, subscriptions, or any regular item. Add each only after it actually happens.</p><form className="mini-form recurring-form" onSubmit={addRecurring}><select value={recurringType} onChange={event => setRecurringType(event.target.value as "Income" | "Expense")}><option>Expense</option><option>Income</option></select><input value={recurringDescription} onChange={event => setRecurringDescription(event.target.value)} placeholder="Description" required /><input list="recurring-categories" value={recurringCategory} onChange={event => setRecurringCategory(event.target.value)} placeholder="Category" required /><datalist id="recurring-categories">{data.categories.map(category => <option value={category} key={category} />)}</datalist><input list="recurring-sources" value={recurringSource} onChange={event => setRecurringSource(event.target.value)} placeholder={recurringType === "Income" ? "Income source" : "Paid to / purpose"} required /><datalist id="recurring-sources">{data.sources.map(source => <option value={source} key={source} />)}</datalist><input aria-label="Recurring amount" type="number" min="1" value={recurringAmount} onChange={event => setRecurringAmount(event.target.value)} placeholder="Amount" required /><button className="button" type="submit">Save template</button></form><div className="recurring-list">{data.recurring.map(item => <article key={item.id}><div className={`transaction-icon ${item.type.toLowerCase()}`}>{item.type === "Income" ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</div><div><b>{item.description}</b><span>{item.category} · {money(item.amount)} · usually day {item.day}</span></div><button className="button secondary compact" onClick={() => recordRecurring(item)}>Add this month</button><button className="icon-button danger" onClick={() => setData(current => ({ ...current, recurring: current.recurring.filter(entry => entry.id !== item.id) }))}><Trash2 size={15} /></button></article>)}</div></section>
    </div></>;
}

function Audit({ data, setData, exportData, importClick, notify }: { data: FinanceData; setData: React.Dispatch<React.SetStateAction<FinanceData>>; exportData: () => void; importClick: () => void; notify: (m: string) => void }) {
  const [newAccount, setNewAccount] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  function addAccount(event: FormEvent) { event.preventDefault(); if (!newAccount.trim()) return; setData(current => ({ ...current, accounts: [...current.accounts, { id: uid(), name: newAccount.trim(), openingBalance: 0 }] })); setNewAccount(""); notify("Account added"); }
  function reset() { if (!confirmReset) { setConfirmReset(true); return; } setData({ ...emptyData, accounts: defaultAccounts.map(account => ({ ...account })) }); setConfirmReset(false); notify("All finance records cleared"); }
  return <><PageIntro eyebrow="ACCOUNTS & DATA / 07" title="Accounts and backup" text="Set the real starting balance of each place where you keep money." />
    <div className="audit-grid"><section className="card opening-card"><div className="audit-symbol"><Landmark size={24} /></div><p className="eyebrow">Your money accounts</p><h2>Current starting point</h2><p>Use the balance each account had before your first recorded transaction.</p><div className="account-list">{data.accounts.map(account => <article key={account.id}><input aria-label={`${account.name} name`} value={account.name} onChange={event => setData(current => ({ ...current, accounts: current.accounts.map(item => item.id === account.id ? { ...item, name: event.target.value } : item) }))} /><input aria-label={`${account.name} opening balance`} type="number" step="0.01" value={account.openingBalance} onChange={event => setData(current => ({ ...current, accounts: current.accounts.map(item => item.id === account.id ? { ...item, openingBalance: +event.target.value } : item) }))} />{data.accounts.length > 1 && <button className="icon-button danger" aria-label={`Delete ${account.name}`} onClick={() => { if (data.transactions.some(transaction => transaction.accountId === account.id || transaction.toAccountId === account.id)) { notify("Move or delete this account's transactions first"); return; } setData(current => ({ ...current, accounts: current.accounts.filter(item => item.id !== account.id) })); }}><Trash2 size={16} /></button>}</article>)}</div><form className="mini-form account-add" onSubmit={addAccount}><input value={newAccount} onChange={event => setNewAccount(event.target.value)} placeholder="New account name" required /><button className="button" type="submit"><Plus size={16} /> Add</button></form></section>
      <section className="card status-card"><p className="eyebrow">System status</p><h2>Your records</h2>{[["Transactions", data.transactions.length], ["Open bills", data.obligations.filter(item => !item.paid).length], ["Budgets", data.budgets.length], ["Savings goals", data.goals.length]].map(([label, count]) => <div className="status-row" key={label}><span>{label}</span><b>{count}</b></div>)}<div className="backup-actions"><button className="button" onClick={exportData}><Download size={17} /> Download backup</button><button className="button secondary" onClick={importClick}><Upload size={17} /> Restore backup</button></div></section>
      <section className="card audit-note"><Scale size={24} /><div><h2>A two-minute weekly habit.</h2><p>Compare each displayed account balance with the real bank, cash, or wallet balance. Correct missing transactions instead of changing the opening figure.</p></div></section>
      <section className="card danger-zone"><div><h3>Clear all finance data</h3><p>This removes transactions, bills, plans, and account balances from your private workspace.</p></div><button className="button danger-button" onClick={reset}>{confirmReset ? "Click again to confirm" : "Clear all records"}</button></section>
    </div></>;
}

function AuthModal({ user, status, onClose, notify, required = false }: { user: User | null; status: "local" | "syncing" | "synced" | "error"; onClose: () => void; notify: (message: string) => void; required?: boolean }) {
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function readableError(value: unknown) {
    const code = typeof value === "object" && value && "code" in value ? String(value.code) : "";
    if (code.includes("operation-not-allowed")) return "Email sign-in must be enabled in the Firebase console first.";
    if (code.includes("invalid-credential")) return "No matching account was found, or the password is incorrect.";
    if (code.includes("user-not-found")) return "No account exists for this email. Select Create an account.";
    if (code.includes("wrong-password")) return "This account exists, but the password is incorrect.";
    if (code.includes("email-already-in-use")) return "This account already exists. Select ‘I already have an account’ to sign in.";
    if (code.includes("invalid-email")) return "Enter a valid email address.";
    if (code.includes("weak-password")) return "Use a password with at least 6 characters.";
    if (code.includes("too-many-requests")) return "Too many attempts. Please wait and try again.";
    return "Could not complete that request. Check Firebase setup and your connection.";
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (mode === "create") await createUserWithEmailAndPassword(auth, email.trim(), password);
      else await signInWithEmailAndPassword(auth, email.trim(), password);
      notify(mode === "create" ? "Private account created" : "Signed in successfully");
      onClose();
    } catch (value) { setError(readableError(value)); }
    finally { setBusy(false); }
  }

  async function resetPassword() {
    if (!email.trim()) { setError("Enter your email address first."); return; }
    setBusy(true); setError("");
    try { await sendPasswordResetEmail(auth, email.trim()); notify("Password reset email sent"); }
    catch (value) { setError(readableError(value)); }
    finally { setBusy(false); }
  }

  async function logOut() {
    await signOut(auth); notify("Signed out securely"); onClose();
  }

  return <div className={`modal-layer ${required ? "required-auth" : ""}`} role="dialog" aria-modal="true" aria-label="Private cloud sync">
    {!required && <button className="modal-backdrop" onClick={onClose} aria-label="Close" />}
    <section className={`auth-modal ${required ? "auth-gate-card" : ""}`}>
      {!required && <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>}
      <div className="auth-icon">{user ? <Cloud size={24} /> : <ShieldCheck size={24} />}</div>
      {user ? <>
        <p className="eyebrow">Private cloud</p><h2>Signed in</h2>
        <p>Your finance records are linked to <b>{user.email}</b>.</p>
        <div className={`sync-state ${status}`}><span />{status === "error" ? "Firestore is not available yet" : "Private background sync active"}</div>
        <button className="button secondary full" onClick={logOut}><LogOut size={17} /> Sign out</button>
      </> : <>
        <p className="eyebrow">Private cloud backup</p><h2>{mode === "create" ? "Create your account" : "Sign in to FORTRESS"}</h2>
        <p>Sync records privately across your devices. Each account can access only its own data.</p>
        <form onSubmit={submit} className="auth-form">
          <Field label="Email address" full><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
          <div className="field full"><label htmlFor="auth-password">Password</label><div className="password-field"><input id="auth-password" type={showPassword ? "text" : "password"} minLength={6} autoComplete={mode === "create" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} required /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></div>
          {error && <div className="auth-error">{error}</div>}
          <button className="button full" disabled={busy} type="submit"><LogIn size={17} /> {busy ? "Please wait…" : mode === "create" ? "Create private account" : "Sign in"}</button>
        </form>
        <div className="auth-links"><button onClick={() => { setMode(mode === "signin" ? "create" : "signin"); setError(""); }}>{mode === "signin" ? "Create an account" : "I already have an account"}</button>{mode === "signin" && <button onClick={resetPassword}>Forgot password?</button>}</div>
      </>}
    </section>
  </div>;
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) { return <label className={`field ${full ? "full" : ""}`}><span>{label}</span>{children}</label>; }

function TransactionRow({ transaction: t, accounts }: { transaction: Transaction; accounts: Account[] }) {
  const Icon = t.type === "Income" ? ArrowDownLeft : t.type === "Expense" ? ArrowUpRight : ArrowLeftRight;
  const from = accounts.find(account => account.id === t.accountId)?.name || "Account";
  const to = accounts.find(account => account.id === t.toAccountId)?.name;
  return <div className="transaction-row"><div className={`transaction-icon ${t.type.toLowerCase()}`}><Icon size={18} /></div><div className="transaction-main"><b>{t.description}</b><span>{prettyDate(t.date)} · {t.type === "Transfer" && to ? `${from} → ${to}` : `${from} · ${t.business}`}</span></div><div className={`transaction-amount ${t.type.toLowerCase()}`}>{t.type === "Income" ? "+" : t.type === "Expense" ? "−" : ""}{money(t.amount)}</div></div>;
}

function Empty({ icon: Icon, title, text, action, onClick }: { icon: typeof Gauge; title: string; text: string; action?: string; onClick?: () => void }) { return <div className="empty"><div><Icon size={25} /></div><h3>{title}</h3><p>{text}</p>{action && <button className="button secondary" onClick={onClick}>{action}</button>}</div>; }
