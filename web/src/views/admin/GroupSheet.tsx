import { useEffect, useMemo, useState } from "react";
import { Search, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { can, canGrantRole } from "@/lib/adminAccess";
import { aliasList, describeDirectoryError, quotasWithDisk, updateAccount, DISK_QUOTA, type EmailAlias } from "@/lib/adminDirectory";
import {
  createGroup,
  destroyGroup,
  groupRoleKey,
  groupRolesFromKey,
  listMembers,
  searchUsers,
  setMembership,
  type DirectoryGroup,
  type GroupMember,
} from "@/lib/adminGroups";
import { formatSize } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import { Avatar, Spinner } from "@/ui/misc";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { Aliases } from "./AccountSheet";
import { isSelf, type DirectoryContext } from "./directoryContext";
import { usePermissions } from "./usePermissions";

const GIB = 1024 ** 3;
const gibOf = (bytes: number | undefined) => (bytes ? String(Math.round((bytes / GIB) * 10) / 10) : "");
const bytesOf = (gib: string) => {
  const n = Number(gib.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * GIB) : null;
};

interface Props {
  /** Null to create one. */
  group: DirectoryGroup | null;
  ctx: DirectoryContext;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

/**
 * One group, opened beside the list.
 *
 * Its own fields save together, as an account's do. Members are not part of
 * that save: each is a change to the *member's* account, made when it is
 * asked for, because that is where Stalwart keeps it and a half-saved list of
 * people is worse than a list that is always what the server has.
 */
export function GroupSheet({ group, ctx, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = group === null;
  const editable = creating ? can(perms, "Account", "Create") : can(perms, "Account", "Update");

  const [description, setDescription] = useState(group?.description ?? "");
  const [name, setName] = useState("");
  const [domainId, setDomainId] = useState(ctx.domains[0]?.id ?? "");
  const [role, setRole] = useState(groupRoleKey(group?.roles));
  const [quota, setQuota] = useState(gibOf(group?.quotas?.[DISK_QUOTA]));
  const [aliases, setAliases] = useState<EmailAlias[]>(() => Object.values(group?.aliases ?? {}));
  const [members, setMembers] = useState<{ members: GroupMember[]; total: number } | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersRevision, setMembersRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId && ctx.domains[0]) setDomainId(ctx.domains[0].id);
  }, [ctx.domains, domainId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!group) return;
    let canceled = false;
    setMembersError(null);
    listMembers(group.id).then(
      (m) => !canceled && setMembers(m),
      (err) => {
        if (canceled) return;
        setMembers({ members: [], total: 0 });
        setMembersError(describeDirectoryError(err, "group"));
      },
    );
    return () => {
      canceled = true;
    };
  }, [group, membersRevision]);

  const domainName = (id: string) => ctx.domains.find((d) => d.id === id)?.name ?? "";
  const address = group?.emailAddress ?? `${name}@${domainName(domainId)}`;

  const roleOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [{ value: "Default", label: t("Default group role") }];
    for (const r of ctx.roles?.values() ?? []) {
      if (canGrantRole(perms, r.id, ctx.roles)) options.push({ value: `custom:${r.id}`, label: r.description || r.id });
    }
    if (!options.some((o) => o.value === role)) {
      const ids = role.startsWith("custom:") ? role.slice(7).split(",") : [];
      const label = ids.map((id) => ctx.roles?.get(id)?.description).filter(Boolean).join(", ") || t("Custom role");
      options.push({ value: role, label });
    }
    return options;
  }, [perms, ctx.roles, role]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeDirectoryError(err, "group"));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!group) {
        if (!name.trim() || !domainId) {
          setError(t("A group needs an address."));
          return;
        }
        const id = await createGroup({ name, domainId, description, roles: groupRolesFromKey(role), diskQuotaBytes: bytesOf(quota) });
        toast.success(t("Created {address}", { address }));
        onCreated(id);
        return;
      }
      const patch: Record<string, unknown> = {};
      if ((group.description ?? "") !== description) patch.description = description.trim() || null;
      if (groupRoleKey(group.roles) !== role) patch.roles = groupRolesFromKey(role);
      if ((group.quotas?.[DISK_QUOTA] ?? null) !== bytesOf(quota)) patch.quotas = quotasWithDisk(group.quotas, bytesOf(quota));
      if (JSON.stringify(aliasList(Object.values(group.aliases ?? {}))) !== JSON.stringify(aliasList(aliases))) patch.aliases = aliasList(aliases);
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateAccount(group.id, patch);
      toast.success(t("Saved {address}", { address }));
      onChanged();
    });

  const membersChanged = () => {
    setMembersRevision((n) => n + 1);
    onChanged();
  };

  const used = group?.usedDiskQuota ?? 0;
  const limit = group?.quotas?.[DISK_QUOTA];

  return (
    <aside className="admin-sheet" aria-label={creating ? t("New group") : address}>
      <div className="admin-sheet-head">
        {group && <Avatar who={{ name: group.description || group.name, email: group.emailAddress }} />}
        <div className="grow">
          <h2 className="truncate">{creating ? t("New group") : group.description || group.name}</h2>
          {group && <div className="hint truncate notranslate" translate="no">{group.emailAddress}</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {!creating && !editable && <p className="admin-notice">{t("Your role lets you view groups but not change them.")}</p>}

        <h3>{t("Profile")}</h3>
        <div className="field">
          <label htmlFor="admin-group-description">{t("Display name")}</label>
          <input id="admin-group-description" className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="admin-group-name">{t("Address")}</label>
            <div className="row admin-address">
              <input id="admin-group-name" className="input" value={name} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
              <span className="muted">@</span>
              <select className="input" aria-label={t("Domain")} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {ctx.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            {!ctx.domains.length && <span className="hint">{t("No domains are available to create a group on.")}</span>}
          </div>
        )}

        {!creating && (
          <>
            <h3>{t("Members")}</h3>
            <Members
              group={group}
              ctx={ctx}
              members={members}
              error={membersError}
              editable={editable}
              onChanged={membersChanged}
            />

            <h3>{t("Other addresses")}</h3>
            <Aliases
              aliases={aliases}
              setAliases={setAliases}
              editable={editable}
              domains={ctx.domains}
              defaultDomain={group.domainId}
              domainName={domainName}
              hint={t("Mail to these addresses is delivered to this group. Changes apply when you save.")}
            />
          </>
        )}

        <h3>{t("Role")}</h3>
        <select className="input admin-wide" aria-label={t("Role")} value={role} disabled={!editable} onChange={(e) => setRole(e.target.value)}>
          {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="hint">{t("What the group itself may do. Members keep their own roles: a group gives them what is shared with it, not its permissions. Only roles whose permissions you hold yourself are offered.")}</p>

        <h3>{t("Storage")}</h3>
        {!creating && (
          <p className="hint" style={{ marginTop: 0 }}>
            {limit ? t("{used} of {total}", { used: formatSize(used), total: formatSize(limit) }) : t("{used} · no limit", { used: formatSize(used) })}
          </p>
        )}
        <div className="field">
          <label htmlFor="admin-group-quota">{t("Limit in GB")}</label>
          <input id="admin-group-quota" className="input admin-narrow" inputMode="decimal" value={quota} disabled={!editable} placeholder={t("No limit")} onChange={(e) => setQuota(e.target.value)} />
        </div>

        {error && <p className="admin-notice error" role="alert">{error}</p>}

        {!creating && can(perms, "Account", "Destroy") && (
          <DeleteGroup
            group={group}
            memberIds={members?.members.map((m) => m.id) ?? null}
            total={members?.total ?? 0}
            blocked={
              members === null
                ? t("Loading the group's members…")
                : members.total > members.members.length
                  ? t("This group has more members than can be taken out at once.")
                  : members.total > 0 && !can(perms, "Account", "Update")
                    ? t("Deleting a group takes its members out of it first, and your role can't change their accounts.")
                    : null
            }
            onDeleted={onDeleted}
          />
        )}
      </div>

      {editable && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || (creating && (!name || !domainId))} onClick={() => void save()}>
            {creating ? t("Create group") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function Members({ group, ctx, members, error, editable, onChanged }: {
  group: DirectoryGroup;
  ctx: DirectoryContext;
  members: { members: GroupMember[]; total: number } | null;
  error: string | null;
  editable: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (member: GroupMember, join: boolean) => {
    setBusyId(member.id);
    setFailure(null);
    try {
      await setMembership([member.id], group.id, join);
      const who = member.emailAddress ?? member.name;
      toast.success(join ? t("Added {address} to the group", { address: who }) : t("Removed {address} from the group", { address: who }));
      onChanged();
    } catch (err) {
      setFailure(describeDirectoryError(err, "group"));
    } finally {
      setBusyId(null);
    }
  };

  if (members === null) return <Spinner />;
  const present = new Set(members.members.map((m) => m.id));
  return (
    <div>
      {error && <p className="admin-notice error" role="alert">{error}</p>}
      {members.members.length ? (
        <ul className="admin-members">
          {members.members.map((m) => {
            const self = isSelf(m, ctx);
            return (
              <li key={m.id}>
                <Avatar who={{ name: m.description || m.name, email: m.emailAddress }} size="sm" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">
                    {m.description || m.name}
                    {self && <span className="badge muted">{t("You")}</span>}
                  </div>
                  <div className="hint truncate notranslate" translate="no">{m.emailAddress}</div>
                </div>
                {editable && (
                  <button
                    className="icon-btn sm"
                    aria-label={t("Remove {address} from the group", { address: m.emailAddress ?? m.name })}
                    title={self ? t("You can't change your own group memberships.") : t("Remove from group")}
                    disabled={self || busyId !== null}
                    onClick={() => void change(m, false)}
                  >
                    <UserMinus size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !error && <p className="hint" style={{ marginTop: 0 }}>{t("No members yet")}</p>
      )}
      {members.total > members.members.length && (
        <p className="hint">{t("Showing {shown} of {total} members.", { shown: members.members.length, total: members.total })}</p>
      )}
      {failure && <p className="admin-notice error" role="alert">{failure}</p>}
      {editable && <AddMember ctx={ctx} exclude={present} busy={busyId !== null} onAdd={(m) => void change(m, true)} />}
      <p className="hint">{t("Members get what is shared with the group, such as its mailbox. Changes apply straight away.")}</p>
    </div>
  );
}

function AddMember({ ctx, exclude, busy, onAdd }: { ctx: DirectoryContext; exclude: Set<string>; busy: boolean; onAdd: (m: GroupMember) => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<GroupMember[] | null>(null);

  useEffect(() => {
    const needle = text.trim();
    if (!needle) {
      setFound(null);
      return;
    }
    let canceled = false;
    const id = window.setTimeout(() => {
      searchUsers(needle).then(
        (list) => !canceled && setFound(list),
        () => !canceled && setFound([]),
      );
    }, 250);
    return () => {
      canceled = true;
      window.clearTimeout(id);
    };
  }, [text]);

  const offered = (found ?? []).filter((m) => !exclude.has(m.id));
  return (
    <div className="admin-add-member">
      <label className="admin-search">
        <Search size={16} aria-hidden="true" />
        <input className="input" type="search" value={text} placeholder={t("Add a member by name or address")} aria-label={t("Add a member")} onChange={(e) => setText(e.target.value)} />
      </label>
      {found !== null && (
        <ul className="admin-members admin-suggestions">
          {offered.length ? (
            offered.map((m) => {
              const self = isSelf(m, ctx);
              return (
                <li key={m.id}>
                  <Avatar who={{ name: m.description || m.name, email: m.emailAddress }} size="sm" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate">{m.description || m.name}</div>
                    <div className="hint truncate notranslate" translate="no">{m.emailAddress}</div>
                  </div>
                  <button
                    className="btn btn-sm"
                    disabled={busy || self}
                    title={self ? t("You can't change your own group memberships.") : undefined}
                    onClick={() => {
                      onAdd(m);
                      setText("");
                    }}
                  >
                    <UserPlus size={14} /> {t("Add")}
                  </button>
                </li>
              );
            })
          ) : (
            <li className="hint">{t("No one else matches")}</li>
          )}
        </ul>
      )}
    </div>
  );
}

function DeleteGroup({ group, memberIds, total, blocked, onDeleted }: { group: DirectoryGroup; memberIds: string[] | null; total: number; blocked: string | null; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = group.emailAddress ?? group.name;
  return (
    <>
      <h3>{t("Delete")}</h3>
      <div className="admin-danger">
        <p>{blocked ?? t("Deletes the group and its mailbox. Its members' own accounts stay.")}</p>
        <button className="btn btn-sm admin-danger-btn" disabled={!!blocked} onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Delete group…")}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Delete {address}?", { address })}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
            <button
              className="btn btn-danger"
              disabled={busy || typed.trim().toLowerCase() !== address.toLowerCase()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await destroyGroup(group.id, memberIds ?? []);
                  toast.success(t("Deleted {address}", { address }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(describeDirectoryError(err, "group"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Delete group")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          {total > 0
            ? plural(total, {
                one: "Its {n} member is taken out of the group first, and loses what was shared with it. The group's own mail is removed in the background, and it can't be undone.",
                other: "Its {n} members are taken out of the group first, and lose what was shared with it. The group's own mail is removed in the background, and it can't be undone.",
              })
            : t("The group's own mail is removed in the background, and it can't be undone.")}
        </p>
        <div className="field">
          <label htmlFor="admin-group-delete-confirm">{t("Type {address} to confirm", { address })}</label>
          <input id="admin-group-delete-confirm" className="input notranslate" translate="no" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}

