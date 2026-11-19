import { Component, computed, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

interface Stock {
  id: number;
  date: string; // YYYY-MM-DD
  code: string;
  name: string;
  sellVolume: number; // lots
  price: number; // IDR
  pct?: number; // % change today (auto entries)
  source: 'auto' | 'manual';
  side?: 'sell' | 'buy'; // buy = top gainers; missing = sell
}

const STORAGE_KEY = 'ihsg-top-sell-v2';
// Demo credentials only. For production, authenticate against a real backend.
// Always-shown stocks (hardcoded). Their prices still come live from the API.
const PINNED: { code: string; name: string }[] = [
  { code: 'BBCA', name: 'Bank Central Asia' },
  { code: 'TPIA', name: 'Chandra Asri Pacific' },
];

// Request pacing (HTTP 429 = too many requests; free plans are strict).
const DISCOVER_EVERY = 5 * 60_000; // refresh the top-seller list every 5 min
const PRICES_EVERY = 60_000; // refresh prices every 1 min
const RATE_PAUSE = 5 * 60_000; // pause after a 429
const LAST_DISCOVER_KEY = 'ihsg-last-discover';
const CFG_KEY = 'ihsg-api-cfg-v1';
// Default GoAPI settings. Key is visible to anyone who can open this file or the served app.
const DEFAULT_CFG = { baseUrl: 'https://api.goapi.io', apiKey: '6d89622b-8f30-55f4-5eec-996da0c5', topPath: '/stock/idx/top_loser', gainerPath: '/stock/idx/top_gainer' };
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

const today = () => new Date().toISOString().slice(0, 10);

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule],
  template: `
    <header>
      <div class="brand">
        <h1>IHSG Top 10 Sell</h1>
        <p>Which stocks Indonesian investors sold the most, day by day</p>
      </div>
      <div class="auth">
        <span class="badge" [class.admin]="isAdmin()">{{ isAdmin() ? 'ADMIN' : 'GUEST' }}</span>
        @if (isAdmin()) {
          <button (click)="logout()">Logout</button>
        } @else {
          <button class="primary" (click)="showLogin.set(true)">Admin Login</button>
        }
      </div>
    </header>

    <main>
      <div class="toolbar">
        <label>Date
          <input type="date" [ngModel]="selectedDate()" (ngModelChange)="selectedDate.set($event); refresh()" />
        </label>
        <button (click)="refresh(true)" [disabled]="loading()">{{ loading() ? 'Loading...' : 'Refresh' }}</button>
        <span class="count">{{ dayStocks().length }} entries</span>
        <span class="status" [class.err]="!!priceError()">{{ priceError() || statusText() }}</span>
      </div>

      <h3 class="sec">Top 10 sell</h3>
      <div class="panel"><div class="scroll">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Code</th><th>Name</th>
            <th class="num">Sell Volume (lot)</th>
            <th class="num">Live Price (IDR)</th>
            <th class="num">Change</th>
            <th class="num">Sell Value (IDR)</th>
            @if (isAdmin()) { <th>Actions</th> }
          </tr>
        </thead>
        <tbody>
          @for (s of top10(); track s.id; let i = $index) {
            <tr>
              <td><span class="rank" [class.r1]="i === 0" [class.r2]="i === 1" [class.r3]="i === 2">{{ i + 1 }}</span></td>
              <td><strong>{{ s.code }}</strong></td>
              <td>{{ s.name }}</td>
              <td class="num vol">
                <span class="bar" [style.width.%]="barPct(s)"></span>
                <span class="v">{{ s.sellVolume.toLocaleString('id-ID') }}</span>
              </td>
              <td class="num">
                {{ price(s).toLocaleString('id-ID') }}
                @if (!live()[s.code]) { <small class="muted">manual</small> }
              </td>
              <td class="num" [class.up]="(live()[s.code]?.pct ?? 0) > 0" [class.down]="(live()[s.code]?.pct ?? 0) < 0">
                @if (live()[s.code]; as q) { {{ q.pct > 0 ? '+' : '' }}{{ q.pct.toFixed(2) }}% } @else { - }
              </td>
              <td class="num">{{ (s.sellVolume * 100 * price(s)).toLocaleString('id-ID') }}</td>
              @if (isAdmin()) {
                <td class="actions">
                  @if (s.source === 'manual') {
                    <button (click)="startEdit(s)">Edit</button>
                    <button class="danger" (click)="remove(s)">Remove</button>
                  } @else { <small class="muted">auto</small> }
                </td>
              }
            </tr>
          } @empty {
            <tr><td [attr.colspan]="isAdmin() ? 8 : 7" class="muted center">{{ emptyText() }}</td></tr>
          }
        </tbody>
      </table>
      </div></div>
      <p class="note">Top sellers are today's biggest losers on the IDX and the highest list is today's top gainers. Both are found automatically and ranked by traded volume (or by the size of the move when volume is not provided). Past days show what this browser saved while the app was open.</p>

      <h3 class="sec buyhead">Top 10 highest (top gainers)</h3>
      <div class="panel buy"><div class="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Code</th><th>Name</th>
              <th class="num">Volume (lot)</th>
              <th class="num">Live Price (IDR)</th>
              <th class="num">Change</th>
              <th class="num">Value (IDR)</th>
            </tr>
          </thead>
          <tbody>
            @for (s of buyTop10(); track s.id; let i = $index) {
              <tr>
                <td><span class="rank" [class.r1]="i === 0" [class.r2]="i === 1" [class.r3]="i === 2">{{ i + 1 }}</span></td>
                <td><strong>{{ s.code }}</strong></td>
                <td>{{ s.name }}</td>
                <td class="num vol">
                  <span class="bar" [style.width.%]="barPct(s)"></span>
                  <span class="v">{{ s.sellVolume.toLocaleString('id-ID') }}</span>
                </td>
                <td class="num">{{ price(s).toLocaleString('id-ID') }}</td>
                <td class="num" [class.up]="(live()[s.code]?.pct ?? s.pct ?? 0) > 0" [class.down]="(live()[s.code]?.pct ?? s.pct ?? 0) < 0">
                  @if ((live()[s.code]?.pct ?? s.pct) != null) { {{ (live()[s.code]?.pct ?? s.pct ?? 0) > 0 ? '+' : '' }}{{ (live()[s.code]?.pct ?? s.pct ?? 0).toFixed(2) }}% } @else { - }
                </td>
                <td class="num">{{ (s.sellVolume * 100 * price(s)).toLocaleString('id-ID') }}</td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="muted center">{{ emptyText() }}</td></tr>
            }
          </tbody>
        </table>
      </div></div>

      <div class="listhead">
        <h3 class="sub">Stock list &amp; latest price ({{ watchlist().length }})</h3>
        <input class="search" placeholder="Search code or name" [ngModel]="search()" (ngModelChange)="search.set($event)" />
      </div>
      <div class="panel"><div class="scroll">
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th class="num">Latest price (IDR)</th><th class="num">Change</th></tr>
          </thead>
          <tbody>
            @for (w of watchlist(); track w.code) {
              <tr>
                <td><strong>{{ w.code }}</strong>@if (w.pinned) { <small class="muted">pinned</small> }</td>
                <td>{{ w.name }}</td>
                <td class="num">
                  @if (w.price != null) {
                    {{ w.price.toLocaleString('id-ID') }}
                    @if (!w.isLive) { <small class="muted">last saved</small> }
                    @else if (w.asOf && !isToday(w.asOf)) { <small class="muted">as of {{ w.asOf }}</small> }
                  } @else { - }
                </td>
                <td class="num" [class.up]="(w.pct ?? 0) > 0" [class.down]="(w.pct ?? 0) < 0">
                  @if (w.pct != null) { {{ w.pct > 0 ? '+' : '' }}{{ w.pct.toFixed(2) }}% } @else { - }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="muted center">No stocks to show yet.</td></tr>
            }
          </tbody>
        </table>
      </div></div>

      @if (isAdmin()) {
        @if (others().length) {
          <h3 class="sub">Outside top 10</h3>
          <table>
            <tbody>
              @for (s of others(); track s.id) {
                <tr>
                  <td><strong>{{ s.code }}</strong></td>
                  <td>{{ s.name }}</td>
                  <td class="num">{{ s.sellVolume.toLocaleString('id-ID') }}</td>
                  <td class="actions">
                    @if (s.source === 'manual') {
                      <button (click)="startEdit(s)">Edit</button>
                      <button class="danger" (click)="remove(s)">Remove</button>
                    } @else { <small class="muted">auto</small> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }

        <section class="card">
          <h3>Live price API (GoAPI.io)</h3>
          <div class="form">
            <input placeholder="API base URL" [(ngModel)]="cfg.baseUrl" style="min-width:240px" />
            <input placeholder="Top sellers path" [(ngModel)]="cfg.topPath" style="min-width:200px" />
            <input placeholder="Top gainers path" [(ngModel)]="cfg.gainerPath" style="min-width:200px" />
            <input type="password" placeholder="GoAPI API key" [(ngModel)]="cfg.apiKey" />
            <button class="primary" (click)="saveCfg()">Save &amp; refresh</button>
          </div>
          <small class="muted">The key is sent in the X-API-KEY header and stored in this browser. For production, point the base URL to your own backend proxy that holds the key.</small>
        </section>

        <section class="card">
          <h3>{{ editingId() ? 'Edit stock' : 'Add stock' }} ({{ selectedDate() }})</h3>
          <div class="form">
            <input placeholder="Code (e.g. BBCA)" [(ngModel)]="form.code" maxlength="6" />
            <input placeholder="Company name" [(ngModel)]="form.name" />
            <input type="number" placeholder="Sell volume (lot)" [(ngModel)]="form.sellVolume" min="0" />
            <input type="number" placeholder="Price (IDR)" [(ngModel)]="form.price" min="0" />
            <button class="primary" (click)="save()">{{ editingId() ? 'Update' : 'Add' }}</button>
            @if (editingId()) { <button (click)="resetForm()">Cancel</button> }
          </div>
          @if (formError()) { <p class="error">{{ formError() }}</p> }
        </section>
      } @else {
        <p class="muted center">You are viewing as guest (read-only). Login as admin to add, edit or remove stocks.</p>
      }
    </main>

    @if (showLogin()) {
      <div class="overlay" (click)="showLogin.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Admin Login</h3>
          <input placeholder="Username" [(ngModel)]="loginUser" />
          <input type="password" placeholder="Password" [(ngModel)]="loginPass" (keyup.enter)="login()" />
          @if (loginError()) { <p class="error">{{ loginError() }}</p> }
          <div class="actions">
            <button class="primary" (click)="login()">Login</button>
            <button (click)="showLogin.set(false)">Cancel</button>
          </div>
          <small class="hint">Demo: admin / admin123</small>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      --ink:#0f1b2d; --ink-2:#4a5a70; --line:#dbe3ec; --bg:#e9eef4; --card:#ffffff;
      --sell:#c8102e; --sell-soft:#fbe3e7; --up:#0f7a4d; --brand:#12284a; --focus:#2f6df6;
      display:block; min-height:100vh; background:var(--bg); color:var(--ink);
      font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    * { box-sizing:border-box; }
    header { background:var(--brand); color:#fff; padding:28px 20px 76px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;
      border-bottom:6px solid var(--sell); }
    header > * { }
    .brand h1 { margin:0; font-size:clamp(26px,4.5vw,40px); font-weight:800; letter-spacing:-.02em; line-height:1.05; }
    .brand p { margin:8px 0 0; color:#b9c7dc; font-size:15px; max-width:42ch; }
    main { max-width:1000px; margin:-52px auto 0; padding:0 16px 40px; }
    header, main { }
    .auth { display:flex; align-items:center; gap:10px; }
    .badge { padding:4px 11px; border-radius:6px; background:rgba(255,255,255,.14); color:#dbe6f5; font-size:12px; font-weight:700; letter-spacing:.04em; }
    .badge.admin { background:#d7f5e6; color:#0b5a39; }

    .toolbar { display:flex; align-items:center; gap:12px 16px; flex-wrap:wrap; background:var(--card); border:1px solid var(--line); border-radius:14px;
      padding:12px 16px; margin-bottom:16px; box-shadow:0 8px 24px -12px rgba(15,27,45,.25); }
    .toolbar label { display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px; }
    .count { background:var(--sell-soft); color:var(--sell); font-weight:700; font-size:13px; padding:3px 10px; border-radius:999px; }
    .status { font-size:12.5px; color:var(--ink-2); margin-left:auto; } .status.err { color:var(--sell); font-weight:600; }

    .panel { background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; box-shadow:0 8px 24px -12px rgba(15,27,45,.25); }
    .scroll { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:12px 14px; text-align:left; font-size:14.5px; border-bottom:1px solid #eef2f6; white-space:nowrap; }
    th { background:#f4f7fb; color:var(--ink-2); font-size:13px; font-weight:700; border-bottom:1px solid var(--line); }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr:hover td { background:#f8fafd; }
    td strong { font-size:15.5px; letter-spacing:.01em; }
    .num { text-align:right; } .center { text-align:center; padding:28px 16px; }
    .muted { color:var(--ink-2); } small.muted { margin-left:4px; font-size:11.5px; }

    .rank { display:inline-grid; place-items:center; width:28px; height:28px; border-radius:8px; background:#edf1f6; color:var(--ink-2); font-weight:700; font-size:13px; }
    .rank.r1 { background:var(--sell); color:#fff; }
    .rank.r2 { background:#e0566c; color:#fff; }
    .rank.r3 { background:#f0a3af; color:#5b0a18; }

    td.vol { position:relative; min-width:190px; }
    td.vol .bar { position:absolute; right:0; top:8px; bottom:8px; background:var(--sell-soft); border-radius:6px 0 0 6px; transition:width .5s ease; }
    td.vol .v { position:relative; font-weight:700; color:#8c0b20; }

    .up { color:var(--up); font-weight:700; } .down { color:var(--sell); font-weight:700; }

    .actions { display:flex; gap:6px; }
    button { padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); font:inherit; font-size:13.5px; font-weight:600; cursor:pointer;
      transition:background .15s, border-color .15s; }
    button:hover:not(:disabled) { background:#f1f5fa; border-color:#c4d0de; }
    button:disabled { opacity:.55; cursor:default; }
    button.primary { background:var(--sell); color:#fff; border-color:var(--sell); }
    button.primary:hover:not(:disabled) { background:#a80d26; border-color:#a80d26; }
    button.danger { color:var(--sell); border-color:#f1b9c2; }
    button.danger:hover:not(:disabled) { background:var(--sell-soft); }
    header button { background:rgba(255,255,255,.1); color:#fff; border-color:rgba(255,255,255,.25); }
    header button:hover:not(:disabled) { background:rgba(255,255,255,.2); border-color:rgba(255,255,255,.4); }
    header button.primary { background:var(--sell); border-color:var(--sell); }

    input { padding:9px 12px; border:1px solid #c9d4e1; border-radius:8px; background:#fff; color:var(--ink); font:inherit; font-size:14px; }
    button:focus-visible, input:focus-visible { outline:3px solid var(--focus); outline-offset:1px; }

    h3 { margin:0 0 12px; font-size:16px; }
    h3.sub { margin:28px 2px 10px; color:var(--ink-2); font-size:14px; }
    main > table { background:var(--card); border:1px solid var(--line); border-radius:10px; }
    .card { margin-top:20px; padding:18px; border:1px solid var(--line); border-left:5px solid var(--brand); border-radius:6px 14px 14px 6px; background:var(--card); }
    .form { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px; }
    small { color:var(--ink-2); font-size:12.5px; }
    .error { color:var(--sell); font-weight:600; margin:8px 0 0; }

    .overlay { position:fixed; inset:0; background:rgba(15,27,45,.55); display:flex; align-items:center; justify-content:center; padding:16px; }
    .modal { background:#fff; padding:24px; border-radius:16px; width:100%; max-width:340px; display:flex; flex-direction:column; gap:12px; border-top:6px solid var(--sell);
      box-shadow:0 24px 60px -20px rgba(0,0,0,.5); }
    .modal h3 { font-size:20px; margin:0; }
    .hint { color:var(--ink-2); }
    .listhead { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:28px; }
    .listhead h3.sub { margin:0 2px 10px; }
    .search { margin-bottom:10px; min-width:220px; }
    h3.sec { margin:4px 2px 10px; font-size:17px; }
    h3.sec.buyhead { margin-top:28px; }
    .panel.buy .rank.r1 { background:var(--up); color:#fff; }
    .panel.buy .rank.r2 { background:#3a9d75; color:#fff; }
    .panel.buy .rank.r3 { background:#a5d9c2; color:#0b4a30; }
    .panel.buy td.vol .bar { background:#dff3e9; }
    .panel.buy td.vol .v { color:#0b5a39; }
    .note { margin:12px 2px 0; color:var(--ink-2); font-size:12.5px; max-width:80ch; }

    @media (max-width:640px){
      th:nth-child(6), td:nth-child(6), th:nth-child(7), td:nth-child(7){ display:none; }
      header { padding-bottom:70px; }
      .status { margin-left:0; width:100%; }
    }
    @media (prefers-reduced-motion: reduce){ * { transition:none !important; } }
  `],
})
export class App {
  stocks = signal<Stock[]>(this.load());
  selectedDate = signal(today());
  isAdmin = signal(sessionStorage.getItem('ihsg-admin') === '1');

  showLogin = signal(false);
  loginUser = '';
  loginPass = '';
  loginError = signal('');

  editingId = signal<number | null>(null);
  form = { code: '', name: '', sellVolume: null as number | null, price: null as number | null };
  formError = signal('');

  live = signal<Record<string, { price: number; pct: number; date?: string }>>({});
  loading = signal(false);
  priceError = signal('');
  lastUpdate = signal<Date | null>(null);
  statusText = computed(() => {
    const t = this.lastUpdate();
    return t ? `Updated ${t.toLocaleTimeString('id-ID')}` : 'No live data yet';
  });
  cfg = this.loadCfg();

  constructor() {
    this.refresh();
    setInterval(() => this.refresh(), 30000); // checks every 30s; real API calls are throttled inside refresh()
  }

  price(s: Stock): number {
    return this.live()[s.code]?.price ?? s.price;
  }

  saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg)); } catch {}
    this.blockedUntil = 0;
    this.refresh(true);
  }

  private loadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<typeof DEFAULT_CFG>;
        return {
          baseUrl: saved.baseUrl || DEFAULT_CFG.baseUrl,
          apiKey: saved.apiKey || DEFAULT_CFG.apiKey,
          topPath: saved.topPath || DEFAULT_CFG.topPath,
          gainerPath: saved.gainerPath || DEFAULT_CFG.gainerPath,
        };
      }
    } catch {}
    return { ...DEFAULT_CFG };
  }

  isToday(d?: string): boolean {
    return d === today();
  }

  emptyText(): string {
    if (!this.cfg.apiKey) return 'Add your GoAPI key (Admin Login) to load today\'s top sellers.';
    if (this.loading()) return 'Loading top sellers...';
    if (this.selectedDate() !== today()) return 'No saved data for this date.';
    return this.priceError() ? 'Could not load top sellers. See the message above.' : 'No data yet.';
  }

  private blockedUntil = 0;
  private lastPrices = 0;
  private lastForce = 0;
  private lastDiscover = (() => {
    try { return Number(localStorage.getItem(LAST_DISCOVER_KEY)) || 0; } catch { return 0; }
  })();

  async refresh(force = false) {
    if (!this.cfg.apiKey) {
      this.priceError.set('');
      return;
    }
    if (this.loading()) return;
    const now = Date.now();
    if (now < this.blockedUntil) {
      this.priceError.set(`Rate limit reached. Requests paused until ${new Date(this.blockedUntil).toLocaleTimeString('id-ID')}.`);
      return;
    }
    if (force && now - this.lastForce < 10_000) return; // ignore rapid repeat clicks
    if (!force && document.hidden) return; // don't poll from a background tab
    if (force) this.lastForce = now;
    this.loading.set(true);
    this.priceError.set('');
    try {
      if (force || now - this.lastDiscover >= DISCOVER_EVERY) {
        await this.discover();
        this.lastDiscover = Date.now();
        try { localStorage.setItem(LAST_DISCOVER_KEY, String(this.lastDiscover)); } catch {}
      }
      if (force || now - this.lastPrices >= PRICES_EVERY) {
        await this.fetchPrices();
        this.lastPrices = Date.now();
      }
    } catch (e: any) {
      this.priceError.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async get(path: string, extra = ''): Promise<any> {
    const res = await fetch(this.apiUrl(path, extra), {
      headers: { accept: 'application/json', 'X-API-KEY': this.cfg.apiKey },
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After'));
      this.blockedUntil = Date.now() + (isFinite(ra) && ra > 0 ? ra * 1000 : RATE_PAUSE);
      throw new Error(`Rate limit reached (HTTP 429). Requests paused until ${new Date(this.blockedUntil).toLocaleTimeString('id-ID')}. Check your GoAPI plan limits.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return res.json();
  }

  private apiUrl(path: string, extra = ''): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.cfg.baseUrl}${path}${extra ? sep + extra : ''}`;
  }

  /** Finds today's top sellers (biggest losers) and top gainers and stores them as auto entries. */
  private async discover() {
    if (this.selectedDate() !== today()) return; // history is read from saved snapshots
    await this.discoverSide('sell', this.cfg.topPath);
    await this.discoverSide('buy', this.cfg.gainerPath);
  }

  private async discoverSide(side: 'sell' | 'buy', path: string) {
    const d = today();
    const json = await this.get(path);
    // Tolerant parsing: adjust here if your plan returns different field names.
    const rows: any[] = json?.data?.results ?? json?.data ?? [];
    const found: Omit<Stock, 'id'>[] = [];
    const quotes: Record<string, { price: number; pct: number }> = {};
    for (const r of rows) {
      const code = String(r.symbol ?? r.ticker ?? r.code ?? '').toUpperCase();
      if (!code) continue;
      const price = Number(r.close ?? r.price ?? r.last ?? 0);
      const shares = Number(r.volume ?? r.vol ?? 0);
      const pct = Number(r.percent ?? r.change_pct ?? r.pct ?? NaN);
      found.push({
        date: d, code, source: 'auto', side,
        name: String(r.company?.name ?? r.company_name ?? r.name ?? code),
        price: isFinite(price) ? price : 0,
        sellVolume: isFinite(shares) ? Math.round(shares / 100) : 0, // assumes API volume is in shares
        pct: isFinite(pct) ? pct : undefined,
      });
      if (isFinite(price) && price > 0 && isFinite(pct)) quotes[code] = { price, pct };
    }
    if (!found.length) {
      this.priceError.set(`${side === 'sell' ? 'Top sellers' : 'Top gainers'} API returned no rows (check the path / plan).`);
      return;
    }
    const kept = this.stocks().filter((s) => !(s.date === d && s.source === 'auto' && (s.side ?? 'sell') === side));
    let id = Math.max(0, ...this.stocks().map((s) => s.id));
    this.save$([...kept, ...found.map((f) => ({ ...f, id: ++id }))]);
    this.live.set({ ...this.live(), ...quotes });
    this.lastUpdate.set(new Date());
  }

  private async fetchPrices() {
    const codes = [...new Set([...PINNED.map((p) => p.code), ...this.stocks().map((s) => s.code)])];
    if (!codes.length) return;
    const json = await this.get('/stock/idx/prices', `symbols=${codes.join(',')}`);
    const rows: any[] = json?.data?.results ?? json?.data ?? [];
    const out: Record<string, { price: number; pct: number; date?: string }> = {};
    for (const r of rows) {
      const code = String(r.symbol ?? r.ticker ?? '').toUpperCase();
      const price = Number(r.close ?? r.price ?? r.last);
      if (!code || !isFinite(price)) continue;
      let pct = Number(r.change_pct ?? r.percent ?? r.pct ?? NaN);
      if (!isFinite(pct)) {
        const ch = Number(r.change ?? 0);
        pct = price - ch ? (ch / (price - ch)) * 100 : this.live()[code]?.pct ?? 0;
      }
      out[code] = { price, pct, date: r.date ? String(r.date) : undefined };
    }
    if (Object.keys(out).length) {
      this.live.set({ ...this.live(), ...out });
      this.lastUpdate.set(new Date());
    }
  }

  private save$(list: Stock[]) {
    this.stocks.set(list);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
  }

  dayStocks = computed(() =>
    this.stocks()
      .filter((s) => s.date === this.selectedDate() && (s.side ?? 'sell') === 'sell')
      .sort((a, b) => b.sellVolume - a.sellVolume || (a.pct ?? 0) - (b.pct ?? 0))
  );
  search = signal('');
  watchlist = computed(() => {
    const byCode = new Map<string, Stock>();
    for (const s of [...this.stocks()].sort((a, b) => a.date.localeCompare(b.date))) byCode.set(s.code, s);
    const q = this.search().trim().toUpperCase();
    const live = this.live();
    const pinnedCodes = PINNED.map((p) => p.code);
    const rows = [
      ...PINNED.map((p) => ({ code: p.code, name: p.name, saved: byCode.get(p.code), pinned: true })),
      ...[...byCode.values()]
        .filter((s) => !pinnedCodes.includes(s.code))
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((s) => ({ code: s.code, name: s.name, saved: s, pinned: false })),
    ];
    return rows
      .filter((r) => !q || r.code.includes(q) || r.name.toUpperCase().includes(q))
      .map((r) => ({
        code: r.code,
        name: r.name,
        pinned: r.pinned,
        price: live[r.code]?.price ?? (r.saved?.price || null),
        pct: live[r.code]?.pct ?? r.saved?.pct,
        isLive: !!live[r.code],
        asOf: live[r.code]?.date,
      }));
  });

  barPct(s: Stock): number {
    const max = (s.side === 'buy' ? this.buyTop10() : this.top10())[0]?.sellVolume ?? 0;
    return max ? (s.sellVolume / max) * 100 : 0;
  }
  buyTop10 = computed(() =>
    this.stocks()
      .filter((s) => s.date === this.selectedDate() && s.side === 'buy')
      .sort((a, b) => b.sellVolume - a.sellVolume || (b.pct ?? 0) - (a.pct ?? 0))
      .slice(0, 10)
  );
  top10 = computed(() => this.dayStocks().slice(0, 10));
  others = computed(() => this.dayStocks().slice(10));

  login() {
    if (this.loginUser === ADMIN_USER && this.loginPass === ADMIN_PASS) {
      this.isAdmin.set(true);
      sessionStorage.setItem('ihsg-admin', '1');
      this.showLogin.set(false);
      this.loginUser = this.loginPass = '';
      this.loginError.set('');
    } else {
      this.loginError.set('Invalid username or password.');
    }
  }

  logout() {
    this.isAdmin.set(false);
    sessionStorage.removeItem('ihsg-admin');
    this.resetForm();
  }

  startEdit(s: Stock) {
    if (!this.isAdmin() || s.source !== 'manual') return;
    this.editingId.set(s.id);
    this.form = { code: s.code, name: s.name, sellVolume: s.sellVolume, price: s.price };
    this.formError.set('');
  }

  save() {
    if (!this.isAdmin()) return;
    const code = this.form.code.trim().toUpperCase();
    const name = this.form.name.trim();
    const { sellVolume, price } = this.form;
    if (!code || !name || sellVolume == null || price == null || sellVolume < 0 || price < 0) {
      this.formError.set('Please fill all fields with valid values.');
      return;
    }
    const id = this.editingId();
    const dup = this.stocks().some(
      (s) => s.date === this.selectedDate() && s.code === code && s.id !== id
    );
    if (dup) {
      this.formError.set(`${code} already exists on ${this.selectedDate()}.`);
      return;
    }
    if (id) {
      this.update(this.stocks().map((s) => (s.id === id ? { ...s, code, name, sellVolume, price, source: 'manual' as const } : s)));
    } else {
      const nextId = Math.max(0, ...this.stocks().map((s) => s.id)) + 1;
      this.update([...this.stocks(), { id: nextId, date: this.selectedDate(), code, name, sellVolume, price, source: 'manual' }]);
    }
    this.resetForm();
  }

  remove(s: Stock) {
    if (!this.isAdmin() || s.source !== 'manual') return;
    if (confirm(`Remove ${s.code} from ${s.date}?`)) {
      this.update(this.stocks().filter((x) => x.id !== s.id));
      if (this.editingId() === s.id) this.resetForm();
    }
  }

  resetForm() {
    this.editingId.set(null);
    this.form = { code: '', name: '', sellVolume: null, price: null };
    this.formError.set('');
  }

  private update(list: Stock[]) {
    this.stocks.set(list);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
    this.refresh();
  }

  private load(): Stock[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return (JSON.parse(raw) as Stock[]).filter((x) => x.source === 'auto' || x.source === 'manual');
    } catch {}
    return [];
  }
}

bootstrapApplication(App).catch((err) => console.error(err));
