import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, Globe, Hourglass, LayoutDashboard, MemoryStick, RefreshCw, Users } from "lucide-react";
import { adminSections, dashboardCards, type DashboardCard } from "@/lib/admin/adminAccess";
import { balancedColumns, countObjects, DASHBOARD_WINDOW_MS, isRefused, loadMetrics, summarizeMetrics, type MessageStats } from "@/lib/admin/adminDashboard";
import { formatDayMonthTime, resolvedLocale } from "@/lib/datetime";
import { formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";
import { Empty } from "@/ui/misc";
import { useSession } from "@/store/session";
import { usePermissions } from "./usePermissions";

/** Loading, a number, refused by the server (the card goes), or failed (the card says so). */
type Loaded<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "refused" } | { state: "error" };

const LOADING = { state: "loading" } as const;

async function settle<T>(work: Promise<T>): Promise<Loaded<T>> {
  try {
    return { state: "ok", value: await work };
  } catch (err) {
    return isRefused(err) ? { state: "refused" } : { state: "error" };
  }
}

/**
 * Administration's landing page: a card for each number the role may read.
 *
 * Which cards appear is `dashboardCards`, from the permissions Stalwart
 * reported; what they count is whatever Stalwart answers for this account,
 * which for a tenant administrator is their tenancy. A card whose feed the
 * server refuses anyway -- the metric history on a Community server -- is left
 * off rather than shown broken, and one that could not be loaded says so.
 */
export function AdminDashboard() {
  const perms = usePermissions();
  const adminUrl = useSession((s) => s.session?.ihasmail?.server?.adminUrl ?? null);
  const cards = dashboardCards(perms);
  const sections = adminSections(perms);
  const [reload, setReload] = useState(0);
  const [users, setUsers] = useState<Loaded<number>>(LOADING);
  const [domains, setDomains] = useState<Loaded<number>>(LOADING);
  const [pending, setPending] = useState<Loaded<number>>(LOADING);
  const [messages, setMessages] = useState<Loaded<MessageStats>>(LOADING);
  const key = cards.join(",");

  useEffect(() => {
    let canceled = false;
    const into = <T,>(set: (v: Loaded<T>) => void, work: () => Promise<T>) => {
      set(LOADING);
      void settle(work()).then((v) => !canceled && set(v));
    };
    if (cards.includes("users")) into(setUsers, () => countObjects("Account"));
    if (cards.includes("domains")) into(setDomains, () => countObjects("Domain"));
    if (cards.includes("pending")) into(setPending, () => countObjects("QueuedMessage"));
    if (cards.includes("received")) into(setMessages, async () => summarizeMetrics(await loadMetrics(new Date(Date.now() - DASHBOARD_WINDOW_MS))));
    return () => {
      canceled = true;
    };
    // `key` is the card list's contents; the array itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  const number = new Intl.NumberFormat(resolvedLocale());
  const count = (v: Loaded<number>) => (v.state === "ok" ? number.format(v.value) : undefined);
  const stats = messages.state === "ok" ? messages.value : null;
  const unrecorded = stats !== null && !stats.recorded;

  const every: Array<{ id: DashboardCard; loaded: Loaded<unknown>; node: ReactNode }> = [
    { id: "users", loaded: users, node: <Card icon={<Users size={20} />} label={t("Users")} value={count(users)} caption={t("User accounts")} loaded={users} href={sections.includes("accounts") ? "/admin/accounts" : undefined} /> },
    { id: "domains", loaded: domains, node: <Card icon={<Globe size={20} />} label={t("Domains")} value={count(domains)} caption={t("Mail domains")} loaded={domains} href={sections.includes("domains") ? "/admin/domains" : undefined} /> },
    { id: "pending", loaded: pending, node: <Card icon={<Hourglass size={20} />} label={t("Pending")} value={count(pending)} caption={t("Waiting in the delivery queue")} loaded={pending} /> },
    {
      id: "memory",
      loaded: messages,
      node: (
        <Card
          icon={<MemoryStick size={20} />}
          label={t("Server memory")}
          value={stats?.memory ? formatSize(stats.memory.bytes) : undefined}
          caption={stats?.memory ? t("As of {time}", { time: formatDayMonthTime(new Date(stats.memory.at)) }) : unrecorded ? t("Not recorded on this server") : t("Last 24 hours")}
          loaded={messages}
        />
      ),
    },
    { id: "received", loaded: messages, node: <Card icon={<ArrowDownToLine size={20} />} label={t("Received")} value={stats?.recorded ? number.format(stats.received) : undefined} caption={unrecorded ? t("Not recorded on this server") : t("Last 24 hours")} loaded={messages} /> },
    { id: "sent", loaded: messages, node: <Card icon={<ArrowUpFromLine size={20} />} label={t("Sent")} value={stats?.recorded ? number.format(stats.sent) : undefined} caption={unrecorded ? t("Not recorded on this server") : t("Last 24 hours")} loaded={messages} /> },
  ];
  const shown = every.filter((c) => cards.includes(c.id) && c.loaded.state !== "refused");
  const columns = balancedColumns(shown.length);

  return (
    // The column counts are set here rather than on the grid, so the heading --
    // and its Refresh button -- end where the cards do.
    <div className="admin-dashboard" style={{ "--cols-wide": columns.wide, "--cols-mid": columns.mid } as React.CSSProperties}>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Dashboard")}</h1>
          <p className="lead">{t("The numbers your role can see, as the server reports them.")}</p>
        </div>
        <button className="icon-btn" aria-label={t("Refresh")} title={t("Refresh")} onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={18} />
        </button>
      </div>
      {shown.length ? (
        <div className="admin-cards-wrap">
          <div className="admin-cards">
            {shown.map((c) => <div key={c.id}>{c.node}</div>)}
          </div>
        </div>
      ) : (
        <Empty icon={<LayoutDashboard size={32} />} title={t("Nothing to show")} />
      )}
      {/* The line between the two interfaces, said where someone looking for
          more numbers will be: this is a glance, and operating the server is
          Stalwart's own administration. The link is the operator's to give. */}
      <p className="hint admin-dashboard-note">
        {t("Detailed metrics, the delivery queue, logs and server settings are in Stalwart's own administration.")}
        {adminUrl && (
          <>
            {" "}
            <a href={adminUrl} target="_blank" rel="noopener noreferrer">
              {t("Open Stalwart admin")} <ExternalLink size={13} aria-hidden="true" />
            </a>
          </>
        )}
      </p>
    </div>
  );
}

function Card({ icon, label, value, caption, loaded, href }: { icon: ReactNode; label: string; value: string | undefined; caption: string; loaded: Loaded<unknown>; href?: string }) {
  const body = (
    <>
      <div className="admin-card-top">
        <span className="admin-card-icon" aria-hidden="true">{icon}</span>
        <span className="admin-card-label">{label}</span>
      </div>
      <div className="admin-card-value" aria-busy={loaded.state === "loading"}>
        {loaded.state === "loading" ? <span className="admin-card-placeholder" /> : (value ?? "—")}
      </div>
      <div className="hint">{loaded.state === "error" ? t("Could not be loaded") : caption}</div>
    </>
  );
  return href ? (
    <Link href={href} className="admin-card link">{body}</Link>
  ) : (
    <div className="admin-card">{body}</div>
  );
}
