import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Collection, Db } from "mongodb";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

interface UserDocument {
  id: string;
  email: string;
  name: string;
  passwordHash?: string;
  googleSubject?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionDocument {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

interface OAuthStateDocument {
  stateHash: string;
  expiresAt: Date;
}

interface TradingAccountDocument {
  userId: string;
  startingEquity: number;
  paperEquity: number;
  mode: "PAPER" | "ANALYSIS_ONLY" | "LIVE";
  assets: string[];
  risk: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditEventDocument {
  userId: string;
  action: string;
  detail: string;
  createdAt: Date;
}

export interface AuditEvent { action: string; detail: string; createdAt: number; }

export interface TradingAccount {
  userId: string;
  startingEquity: number;
  paperEquity: number;
  mode: "PAPER" | "ANALYSIS_ONLY" | "LIVE";
  assets: string[];
  risk: Record<string, number>;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class MongoAuthService {
  private readonly users: Collection<UserDocument>;
  private readonly sessions: Collection<SessionDocument>;
  private readonly oauthStates: Collection<OAuthStateDocument>;
  private readonly tradingAccounts: Collection<TradingAccountDocument>;
  private readonly auditEvents: Collection<AuditEventDocument>;

  constructor(database: Db, readonly google?: GoogleOAuthConfig) {
    this.users = database.collection<UserDocument>("users");
    this.sessions = database.collection<SessionDocument>("sessions");
    this.oauthStates = database.collection<OAuthStateDocument>("oauth_states");
    this.tradingAccounts = database.collection<TradingAccountDocument>("trading_accounts");
    this.auditEvents = database.collection<AuditEventDocument>("audit_events");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.users.createIndex({ googleSubject: 1 }, { unique: true, sparse: true }),
      this.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.tradingAccounts.createIndex({ userId: 1 }, { unique: true }),
      this.auditEvents.createIndex({ userId: 1, createdAt: -1 }),
    ]);
  }

  async register(emailInput: string, password: string, nameInput?: string): Promise<{ user: AuthUser; token: string }> {
    const email = normalizeEmail(emailInput);
    if (!isPasswordValid(password)) throw new Error("Password must contain at least 12 characters.");
    const now = new Date();
    const user: UserDocument = {
      id: cryptoId(), email, name: normalizedName(nameInput, email), passwordHash: await hashPassword(password), createdAt: now, updatedAt: now,
    };
    try {
      await this.users.insertOne(user);
    } catch (error) {
      if (isDuplicateKey(error)) throw new Error("An account already exists for this email.");
      throw error;
    }
    await this.ensureTradingAccount(user.id);
    await this.recordAudit(user.id, "ACCOUNT_REGISTERED", "Password account created.");
    return { user: publicUser(user), token: await this.createSession(user.id) };
  }

  async login(emailInput: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const user = await this.users.findOne({ email: normalizeEmail(emailInput) });
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw new Error("Invalid email or password.");
    }
    await this.ensureTradingAccount(user.id);
    await this.recordAudit(user.id, "SIGNED_IN", "Password sign-in completed.");
    return { user: publicUser(user), token: await this.createSession(user.id) };
  }

  async userForToken(token: string | undefined): Promise<AuthUser | undefined> {
    if (!token) return undefined;
    const session = await this.sessions.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
    if (!session) return undefined;
    const user = await this.users.findOne({ id: session.userId });
    if (!user) return undefined;
    await this.ensureTradingAccount(user.id);
    return publicUser(user);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const session = await this.sessions.findOneAndDelete({ tokenHash: sha256(token) });
    if (session) await this.recordAudit(session.userId, "SIGNED_OUT", "Session ended.");
  }

  async createGoogleAuthorizationUrl(): Promise<string> {
    if (!this.google) throw new Error("Google sign-in is not configured.");
    const state = randomBytes(32).toString("base64url");
    await this.oauthStates.insertOne({ stateHash: sha256(state), expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS) });
    const params = new URLSearchParams({ client_id: this.google.clientId, redirect_uri: this.google.redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async loginWithGoogle(code: string, state: string): Promise<{ user: AuthUser; token: string }> {
    if (!this.google) throw new Error("Google sign-in is not configured.");
    const consumed = await this.oauthStates.findOneAndDelete({ stateHash: sha256(state), expiresAt: { $gt: new Date() } });
    if (!consumed) throw new Error("Google sign-in session expired. Please try again.");
    const body = new URLSearchParams({ code, client_id: this.google.clientId, client_secret: this.google.clientSecret, redirect_uri: this.google.redirectUri, grant_type: "authorization_code" });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!tokenResponse.ok) throw new Error("Google could not validate the authorization code.");
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) throw new Error("Google did not return an access token.");
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) throw new Error("Google could not retrieve the account profile.");
    const profile = await profileResponse.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!profile.sub || !profile.email || profile.email_verified !== true) throw new Error("A verified Google email address is required.");
    const email = normalizeEmail(profile.email);
    let user: UserDocument | null = await this.users.findOne({ $or: [{ googleSubject: profile.sub }, { email }] });
    if (!user) {
      const now = new Date();
      const newUser: UserDocument = { id: cryptoId(), email, name: normalizedName(profile.name, email), googleSubject: profile.sub, createdAt: now, updatedAt: now };
      await this.users.insertOne(newUser);
      user = newUser;
    } else if (!user.googleSubject) {
      await this.users.updateOne({ id: user.id }, { $set: { googleSubject: profile.sub, updatedAt: new Date() } });
      user.googleSubject = profile.sub;
    }
    await this.ensureTradingAccount(user.id);
    await this.recordAudit(user.id, "GOOGLE_SIGNED_IN", "Google sign-in completed.");
    return { user: publicUser(user), token: await this.createSession(user.id) };
  }

  async getTradingAccount(userId: string): Promise<TradingAccount> {
    await this.ensureTradingAccount(userId);
    const account = await this.tradingAccounts.findOne({ userId });
    if (!account) throw new Error("Trading account could not be created.");
    return { userId: account.userId, startingEquity: account.startingEquity, paperEquity: account.paperEquity, mode: account.mode, assets: account.assets, risk: account.risk };
  }

  async recordAudit(userId: string, action: string, detail: string): Promise<void> {
    await this.auditEvents.insertOne({ userId, action, detail: detail.slice(0, 500), createdAt: new Date() });
  }

  async listAudit(userId: string, limit = 100): Promise<AuditEvent[]> {
    const events = await this.auditEvents.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 200)).toArray();
    return events.map((event) => ({ action: event.action, detail: event.detail, createdAt: event.createdAt.getTime() }));
  }

  async updateTradingAccount(userId: string, patch: { assets?: string[]; risk?: Record<string, number> }): Promise<TradingAccount> {
    const update: Partial<Pick<TradingAccountDocument, "assets" | "risk">> = {};
    if (patch.assets) {
      const assets = [...new Set(patch.assets.map((asset) => asset.trim().toUpperCase()).filter(Boolean))];
      if (!assets.length || assets.length > 30 || assets.some((asset) => !/^[A-Z0-9]{3,30}(?:\/[A-Z0-9]{3,12})?$/.test(asset))) throw new Error("Provide 1–30 market pairs such as BTCUSDT.");
      update.assets = assets;
    }
    if (patch.risk) {
      if (Object.values(patch.risk).some((value) => !Number.isFinite(value))) throw new Error("Risk settings must be numeric.");
      update.risk = patch.risk;
    }
    await this.tradingAccounts.updateOne({ userId }, { $set: { ...update, updatedAt: new Date() } });
    return this.getTradingAccount(userId);
  }

  private async ensureTradingAccount(userId: string): Promise<void> {
    const now = new Date();
    await this.tradingAccounts.updateOne(
      { userId },
      { $setOnInsert: { userId, startingEquity: 10_000, paperEquity: 10_000, mode: "PAPER", assets: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], risk: { riskPerTrade: 1, maxDailyLossPct: 3, maxDrawdownPct: 8 }, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  }

  private async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.sessions.insertOne({ tokenHash: sha256(token), userId, createdAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    return token;
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");
  return email;
}
function normalizedName(name: string | undefined, email: string): string { return name?.trim().slice(0, 100) || email.split("@")[0]; }
function cryptoId(): string { return randomBytes(18).toString("base64url"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function hashPassword(password: string): Promise<string> { const salt = randomBytes(16).toString("base64url"); const key = await scrypt(password, salt, 64) as Buffer; return `${salt}:${key.toString("base64url")}`; }
async function verifyPassword(password: string, stored: string): Promise<boolean> { const [salt, hash] = stored.split(":"); if (!salt || !hash) return false; const expected = Buffer.from(hash, "base64url"); const actual = await scrypt(password, salt, expected.length) as Buffer; return expected.length === actual.length && timingSafeEqual(expected, actual); }
function isPasswordValid(password: string): boolean { return typeof password === "string" && password.length >= 12 && password.length <= 256; }
function publicUser(user: UserDocument): AuthUser { return { id: user.id, email: user.email, name: user.name }; }
function isDuplicateKey(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000; }
