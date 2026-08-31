/* eslint no-underscore-dangle: off */
import React, {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { formatSocialTime } from './social-time';

interface GroupMessage {
  _id: string;
  group_id: string;
  sequence: number;
  sender_id: string;
  sender_label: string;
  sender_type: 'participant' | 'admin';
  message_type: 'message' | 'announcement';
  content: string;
  created_at: string;
}

interface GroupSummary {
  group_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  member_count: number;
  unread_count: number;
  last_read_sequence: number;
  muted: boolean;
  joined_at: string;
  last_message?: GroupMessage | null;
}

interface GroupInvitation {
  invitation_id: string;
  group_id: string;
  group_name: string;
  group_description: string;
  member_count: number;
  status: string;
  created_at: string;
}

interface StudyAnnouncement {
  _id: string;
  title: string;
  content: string;
  created_at: string;
  read_at?: string | null;
}

interface GroupInbox {
  groups: GroupSummary[];
  invitations: GroupInvitation[];
  announcements: StudyAnnouncement[];
  unread_group_count: number;
  invitation_count: number;
  unread_announcement_count: number;
  can_administer: boolean;
}

interface GroupMember {
  participant_id: string;
  joined_at: string;
}

interface AdminInvitation {
  invitation_id: string;
  participant_id: string;
  status: string;
  created_at: string;
}

interface AdminGroup {
  group_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  member_count: number;
  created_at: string;
  invitations: AdminInvitation[];
}

interface AdminGroupReport {
  _id: string;
  group_id: string;
  group_name: string;
  reporter_id: string;
  message_id?: string | null;
  reason: string;
  details: string;
  status: 'open' | 'reviewed' | 'dismissed';
  created_at: string;
}

interface SocialSnapshot {
  groupInbox?: GroupInbox;
}

const EMPTY_INBOX: GroupInbox = {
  groups: [],
  invitations: [],
  announcements: [],
  unread_group_count: 0,
  invitation_count: 0,
  unread_announcement_count: 0,
  can_administer: false,
};

const ACCENT = '#204A79';
const BORDER = '#e5e7eb';
const FONT =
  "'PT Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const S: Record<string, React.CSSProperties> = {
  sectionTitle: {
    margin: '13px 2px 6px',
    color: '#6b7280',
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  card: {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    marginBottom: 6,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: '9px 10px',
    background: '#fff',
    textAlign: 'left',
    fontFamily: FONT,
  },
  cardButton: { cursor: 'pointer' },
  icon: {
    width: 27,
    height: 27,
    borderRadius: 9,
    flex: '0 0 auto',
    display: 'grid',
    placeItems: 'center',
    background: '#e9eff8',
    color: ACCENT,
    fontSize: 13,
    fontWeight: 700,
  },
  cardText: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' },
  title: { color: '#374151', fontSize: 12.5, fontWeight: 700 },
  preview: {
    color: '#6b7280',
    fontSize: 11.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    minWidth: 18,
    height: 18,
    boxSizing: 'border-box',
    padding: '0 5px',
    borderRadius: 9,
    background: '#dc2626',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    lineHeight: '18px',
    textAlign: 'center',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 6 },
  primary: {
    border: 'none',
    borderRadius: 8,
    padding: '6px 9px',
    background: ACCENT,
    color: '#fff',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 11.5,
    fontWeight: 700,
  },
  secondary: {
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '5px 8px',
    background: '#fff',
    color: '#4b5563',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 11,
    fontWeight: 700,
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 4,
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    fontFamily: FONT,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '10px 12px',
    borderBottom: `1px solid ${BORDER}`,
  },
  headerText: { minWidth: 0, flex: 1 },
  back: {
    border: 'none',
    background: 'transparent',
    color: ACCENT,
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 11.5,
    fontWeight: 700,
  },
  conversation: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  messages: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  message: {
    maxWidth: '86%',
    alignSelf: 'flex-start',
    borderRadius: '4px 14px 14px 14px',
    padding: '8px 10px',
    background: '#f3f4f6',
    color: '#1f2937',
    fontSize: 12.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  ownMessage: {
    maxWidth: '86%',
    alignSelf: 'flex-end',
    borderRadius: '14px 14px 4px 14px',
    padding: '8px 10px',
    background: '#dbeafe',
    color: '#1f2937',
    fontSize: 12.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  announcementMessage: {
    maxWidth: '100%',
    alignSelf: 'stretch',
    border: '1px solid #bfdbfe',
    borderRadius: 10,
    padding: '9px 10px',
    background: '#eff6ff',
    color: '#1e3a5f',
    fontSize: 12.5,
  },
  meta: { marginBottom: 3, color: '#6b7280', fontSize: 10.5, fontWeight: 700 },
  composer: {
    display: 'flex',
    gap: 7,
    padding: 10,
    borderTop: `1px solid ${BORDER}`,
  },
  textarea: {
    minHeight: 38,
    flex: 1,
    resize: 'none',
    border: `1px solid ${BORDER}`,
    borderRadius: 9,
    padding: '7px 9px',
    color: '#111827',
    fontFamily: FONT,
    fontSize: 12,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '7px 9px',
    color: '#111827',
    fontFamily: FONT,
    fontSize: 12,
  },
  panel: {
    marginBottom: 8,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: 10,
    background: '#f9fafb',
  },
  error: { margin: '7px 0', color: '#b91c1c', fontSize: 11.5 },
  notice: { margin: '7px 0', color: '#166534', fontSize: 11.5 },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitParticipants(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function time(value: string): string {
  return formatSocialTime(value);
}

export default function GroupsView() {
  const [inbox, setInbox] = useState(EMPTY_INBOX);
  const [currentParticipantId, setCurrentParticipantId] = useState('');
  const [selected, setSelected] = useState<GroupSummary | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [reportingMessageId, setReportingMessageId] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminGroups, setAdminGroups] = useState<AdminGroup[]>([]);
  const [adminReports, setAdminReports] = useState<AdminGroupReport[]>([]);
  const [adminName, setAdminName] = useState('');
  const [adminDescription, setAdminDescription] = useState('');
  const [adminParticipants, setAdminParticipants] = useState('');
  const [adminInvite, setAdminInvite] = useState<Record<string, string>>({});
  const [adminAnnouncement, setAdminAnnouncement] = useState<
    Record<string, string>
  >({});
  const [studyTitle, setStudyTitle] = useState('Study update');
  const [studyAnnouncement, setStudyAnnouncement] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const messageListRef = useRef<HTMLDivElement>(null);

  const loadInbox = useCallback(async () => {
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'social-list-group-inbox',
      )) as GroupInbox | undefined;
      if (result && Array.isArray(result.groups)) setInbox(result);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  const loadAdminGroups = useCallback(async () => {
    try {
      const [groupResult, reportResult] = await Promise.all([
        window.electron?.ipcRenderer.invoke(
          'social-admin-list-groups',
        ) as Promise<{
          groups?: AdminGroup[];
        }>,
        window.electron?.ipcRenderer.invoke(
          'social-admin-list-group-reports',
        ) as Promise<{ reports?: AdminGroupReport[] }>,
      ]);
      setAdminGroups(groupResult?.groups || []);
      setAdminReports(reportResult?.reports || []);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    loadInbox();
    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile) => {
        const participantId = (profile as { participantId?: unknown } | null)
          ?.participantId;
        if (typeof participantId === 'string') {
          setCurrentParticipantId(participantId.trim().toLowerCase());
        }
        return undefined;
      })
      .catch(() => undefined);
    const cleanup = window.electron?.ipcRenderer.on(
      'social-inbox-updated',
      (value) => {
        const groupInbox = (value as SocialSnapshot | undefined)?.groupInbox;
        if (groupInbox) setInbox(groupInbox);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [loadInbox]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  const openGroup = async (group: GroupSummary) => {
    setSelected(group);
    setMessages([]);
    setMembers([]);
    setError('');
    try {
      const [page, memberPage] = await Promise.all([
        window.electron?.ipcRenderer.invoke(
          'social-list-group-messages',
          group.group_id,
        ) as Promise<{ messages?: GroupMessage[] }>,
        window.electron?.ipcRenderer.invoke(
          'social-list-group-members',
          group.group_id,
        ) as Promise<{ members?: GroupMember[] }>,
      ]);
      const nextMessages = page?.messages || [];
      setMessages(nextMessages);
      setMembers(memberPage?.members || []);
      const lastSequence = nextMessages.at(-1)?.sequence;
      if (lastSequence) {
        await window.electron?.ipcRenderer.invoke(
          'social-mark-group-read',
          group.group_id,
          lastSequence,
        );
      }
      await loadInbox();
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  };

  const respondInvitation = async (
    invitation: GroupInvitation,
    action: 'accept' | 'decline',
  ) => {
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        action === 'accept'
          ? 'social-accept-group-invitation'
          : 'social-decline-group-invitation',
        invitation.invitation_id,
      );
      setNotice(
        action === 'accept'
          ? `You joined ${invitation.group_name}.`
          : `Invitation to ${invitation.group_name} declined.`,
      );
      await loadInbox();
    } catch (responseError) {
      setError(errorMessage(responseError));
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-send-group-message',
        selected.group_id,
        draft,
      );
      setDraft('');
      await openGroup(selected);
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  };

  const toggleMute = async () => {
    if (!selected) return;
    const muted = !selected.muted;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-set-group-muted',
        selected.group_id,
        muted,
      );
      setSelected({ ...selected, muted });
      await loadInbox();
    } catch (muteError) {
      setError(errorMessage(muteError));
    }
  };

  const leaveGroup = async () => {
    if (!selected) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-leave-group',
        selected.group_id,
      );
      setSelected(null);
      setNotice(`You left ${selected.name}.`);
      await loadInbox();
    } catch (leaveError) {
      setError(errorMessage(leaveError));
    }
  };

  const submitReport = async (messageId?: string) => {
    if (!selected) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-report-group',
        selected.group_id,
        'other',
        reportDetails,
        messageId,
      );
      setReportingMessageId('');
      setReportDetails('');
      setNotice('Report sent to the study team.');
    } catch (reportError) {
      setError(errorMessage(reportError));
    }
  };

  const markAnnouncementRead = async (announcement: StudyAnnouncement) => {
    if (announcement.read_at) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-mark-announcement-read',
        announcement._id,
      );
      await loadInbox();
    } catch (readError) {
      setError(errorMessage(readError));
    }
  };

  const createAdminGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminName.trim()) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-admin-create-group',
        adminName,
        adminDescription,
        splitParticipants(adminParticipants),
      );
      setAdminName('');
      setAdminDescription('');
      setAdminParticipants('');
      setNotice('Group created and invitations sent.');
      await Promise.all([loadAdminGroups(), loadInbox()]);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  };

  const inviteAdminGroup = async (group: AdminGroup) => {
    const participantIds = splitParticipants(adminInvite[group.group_id] || '');
    if (!participantIds.length) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-admin-invite-group',
        group.group_id,
        participantIds,
      );
      setAdminInvite((current) => ({ ...current, [group.group_id]: '' }));
      setNotice('Invitations sent.');
      await loadAdminGroups();
    } catch (inviteError) {
      setError(errorMessage(inviteError));
    }
  };

  const sendAdminGroupAnnouncement = async (group: AdminGroup) => {
    const content = adminAnnouncement[group.group_id]?.trim();
    if (!content) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-admin-send-group-announcement',
        group.group_id,
        content,
      );
      setAdminAnnouncement((current) => ({ ...current, [group.group_id]: '' }));
      setNotice(`Announcement sent to ${group.name}.`);
      await loadInbox();
    } catch (announcementError) {
      setError(errorMessage(announcementError));
    }
  };

  const sendStudyAnnouncement = async (event: FormEvent) => {
    event.preventDefault();
    if (!studyTitle.trim() || !studyAnnouncement.trim()) return;
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-admin-send-study-announcement',
        studyTitle,
        studyAnnouncement,
      );
      setStudyAnnouncement('');
      setNotice('Study-wide announcement sent.');
      await loadInbox();
    } catch (announcementError) {
      setError(errorMessage(announcementError));
    }
  };

  if (selected) {
    return (
      <div style={S.overlay} data-testid="group-conversation">
        <div style={S.header}>
          <span style={S.headerText}>
            <span style={{ ...S.title, display: 'block' }}>
              {selected.name}
            </span>
            <span style={S.preview}>
              {selected.member_count} members ·{' '}
              {selected.muted ? 'Muted' : 'Notifications on'}
            </span>
          </span>
          <button
            type="button"
            style={S.secondary}
            onClick={() => setShowMembers(!showMembers)}
          >
            Members
          </button>
          <button
            type="button"
            style={S.back}
            onClick={() => setSelected(null)}
          >
            Back
          </button>
        </div>
        {showMembers && (
          <div style={{ ...S.panel, margin: 10 }}>
            <div style={S.meta}>ACTIVE MEMBERS</div>
            {members.map((member) => (
              <div
                key={member.participant_id}
                style={{ fontSize: 12, padding: '2px 0' }}
              >
                {member.participant_id}
              </div>
            ))}
            <div style={{ ...S.actions, marginTop: 8 }}>
              <button type="button" style={S.secondary} onClick={toggleMute}>
                {selected.muted ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                style={S.secondary}
                onClick={() => setReportingMessageId('group')}
              >
                Report group
              </button>
              <button
                type="button"
                style={{ ...S.secondary, color: '#b91c1c' }}
                onClick={leaveGroup}
              >
                Leave group
              </button>
            </div>
          </div>
        )}
        {error && <div style={{ ...S.error, margin: '7px 12px' }}>{error}</div>}
        {notice && (
          <div style={{ ...S.notice, margin: '7px 12px' }}>{notice}</div>
        )}
        {reportingMessageId && (
          <div style={{ ...S.panel, margin: 10 }}>
            <div style={S.meta}>REPORT TO STUDY TEAM</div>
            <textarea
              aria-label="Report details"
              style={{ ...S.textarea, width: '100%', boxSizing: 'border-box' }}
              maxLength={1_000}
              placeholder="What should the study team review?"
              value={reportDetails}
              onChange={(event) => setReportDetails(event.target.value)}
            />
            <div style={{ ...S.actions, marginTop: 7 }}>
              <button
                type="button"
                style={S.primary}
                onClick={() =>
                  submitReport(
                    reportingMessageId === 'group'
                      ? undefined
                      : reportingMessageId,
                  )
                }
              >
                Send report
              </button>
              <button
                type="button"
                style={S.secondary}
                onClick={() => setReportingMessageId('')}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div style={S.conversation}>
          <div style={S.messages} ref={messageListRef}>
            {!messages.length && (
              <div style={S.preview}>No messages yet. Say hello.</div>
            )}
            {messages.map((message) => {
              const isOwnMessage =
                message.message_type === 'message' &&
                Boolean(currentParticipantId) &&
                message.sender_id.trim().toLowerCase() === currentParticipantId;
              let messageStyle = S.message;
              if (message.message_type === 'announcement') {
                messageStyle = S.announcementMessage;
              } else if (isOwnMessage) {
                messageStyle = S.ownMessage;
              }
              return (
                <div key={message._id} style={messageStyle}>
                  <div
                    style={{
                      ...S.meta,
                      textAlign: isOwnMessage ? 'right' : 'left',
                    }}
                  >
                    {message.message_type === 'announcement'
                      ? '◆ Study team announcement'
                      : message.sender_label}
                    {' · '}
                    {time(message.created_at)}
                  </div>
                  {message.content}
                </div>
              );
            })}
          </div>
          {selected.status === 'active' ? (
            <form style={S.composer} onSubmit={sendMessage}>
              <textarea
                aria-label={`Message ${selected.name}`}
                style={S.textarea}
                maxLength={4_000}
                placeholder="Message the group…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                style={S.primary}
                disabled={!draft.trim() || sending}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
          ) : (
            <div
              style={{
                ...S.preview,
                padding: 12,
                borderTop: `1px solid ${BORDER}`,
              }}
            >
              This group is archived and read-only.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (showAdmin) {
    return (
      <div style={S.overlay} data-testid="group-admin">
        <div style={S.header}>
          <span style={{ ...S.title, flex: 1 }}>
            Study group administration
          </span>
          <button
            type="button"
            style={S.back}
            onClick={() => setShowAdmin(false)}
          >
            Back to Social
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {error && <div style={S.error}>{error}</div>}
          {notice && <div style={S.notice}>{notice}</div>}
          <form style={S.panel} onSubmit={createAdminGroup}>
            <div style={S.meta}>CREATE INVITATION-ONLY GROUP</div>
            <input
              aria-label="New group name"
              style={S.input}
              maxLength={80}
              placeholder="Group name"
              value={adminName}
              onChange={(event) => setAdminName(event.target.value)}
            />
            <textarea
              aria-label="New group description"
              style={{
                ...S.textarea,
                width: '100%',
                boxSizing: 'border-box',
                marginTop: 6,
              }}
              maxLength={500}
              placeholder="Purpose and expectations"
              value={adminDescription}
              onChange={(event) => setAdminDescription(event.target.value)}
            />
            <input
              aria-label="Initial participant IDs"
              style={{ ...S.input, marginTop: 6 }}
              placeholder="Participant IDs, comma separated"
              value={adminParticipants}
              onChange={(event) => setAdminParticipants(event.target.value)}
            />
            <button
              type="submit"
              style={{ ...S.primary, marginTop: 7 }}
              disabled={!adminName.trim()}
            >
              Create and invite
            </button>
          </form>
          <form style={S.panel} onSubmit={sendStudyAnnouncement}>
            <div style={S.meta}>STUDY-WIDE ANNOUNCEMENT</div>
            <input
              aria-label="Study announcement title"
              style={S.input}
              maxLength={120}
              value={studyTitle}
              onChange={(event) => setStudyTitle(event.target.value)}
            />
            <textarea
              aria-label="Study announcement"
              style={{
                ...S.textarea,
                width: '100%',
                boxSizing: 'border-box',
                marginTop: 6,
              }}
              maxLength={4_000}
              value={studyAnnouncement}
              onChange={(event) => setStudyAnnouncement(event.target.value)}
            />
            <button
              type="submit"
              style={{ ...S.primary, marginTop: 7 }}
              disabled={!studyTitle.trim() || !studyAnnouncement.trim()}
            >
              Broadcast to study
            </button>
          </form>
          {!!adminReports.length && (
            <>
              <div style={S.sectionTitle}>Open reports</div>
              {adminReports.map((report) => (
                <div key={report._id} style={S.panel}>
                  <div style={S.title}>{report.group_name}</div>
                  <div style={{ ...S.preview, whiteSpace: 'normal' }}>
                    {report.reporter_id} · {report.reason}
                    {report.message_id
                      ? ' · message report'
                      : ' · group report'}
                  </div>
                  {report.details && (
                    <div
                      style={{ marginTop: 5, color: '#374151', fontSize: 11.5 }}
                    >
                      {report.details}
                    </div>
                  )}
                  <div style={{ ...S.actions, marginTop: 7 }}>
                    <button
                      type="button"
                      style={S.primary}
                      onClick={async () => {
                        await window.electron?.ipcRenderer.invoke(
                          'social-admin-review-group-report',
                          report._id,
                          'reviewed',
                        );
                        await loadAdminGroups();
                      }}
                    >
                      Mark reviewed
                    </button>
                    <button
                      type="button"
                      style={S.secondary}
                      onClick={async () => {
                        await window.electron?.ipcRenderer.invoke(
                          'social-admin-review-group-report',
                          report._id,
                          'dismissed',
                        );
                        await loadAdminGroups();
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
          <div style={S.sectionTitle}>Manage groups</div>
          {adminGroups.map((group) => (
            <div key={group.group_id} style={S.panel}>
              <div
                style={{
                  ...S.title,
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{group.name}</span>
                <span style={{ color: '#6b7280', fontSize: 10.5 }}>
                  {group.status}
                </span>
              </div>
              <div style={S.preview}>{group.member_count} active members</div>
              <div style={{ ...S.actions, marginTop: 7 }}>
                <input
                  aria-label={`Invite participants to ${group.name}`}
                  style={S.input}
                  placeholder="Participant IDs"
                  value={adminInvite[group.group_id] || ''}
                  onChange={(event) =>
                    setAdminInvite((current) => ({
                      ...current,
                      [group.group_id]: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  style={S.secondary}
                  onClick={() => inviteAdminGroup(group)}
                >
                  Invite
                </button>
              </div>
              <div style={{ ...S.actions, marginTop: 7 }}>
                <textarea
                  aria-label={`Announcement to ${group.name}`}
                  style={S.textarea}
                  maxLength={4_000}
                  placeholder="Group announcement"
                  value={adminAnnouncement[group.group_id] || ''}
                  onChange={(event) =>
                    setAdminAnnouncement((current) => ({
                      ...current,
                      [group.group_id]: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  style={S.secondary}
                  onClick={() => sendAdminGroupAnnouncement(group)}
                >
                  Send
                </button>
              </div>
              {group.invitations
                .filter((invitation) => invitation.status === 'pending')
                .map((invitation) => (
                  <div
                    key={invitation.invitation_id}
                    style={{ ...S.actions, marginTop: 6 }}
                  >
                    <span style={{ ...S.preview, flex: 1 }}>
                      {invitation.participant_id} · pending
                    </span>
                    <button
                      type="button"
                      style={S.secondary}
                      onClick={async () => {
                        await window.electron?.ipcRenderer.invoke(
                          'social-admin-revoke-invitation',
                          invitation.invitation_id,
                        );
                        await loadAdminGroups();
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              <button
                type="button"
                style={{ ...S.secondary, marginTop: 8 }}
                onClick={async () => {
                  await window.electron?.ipcRenderer.invoke(
                    'social-admin-update-group',
                    group.group_id,
                    {
                      status: group.status === 'active' ? 'archived' : 'active',
                    },
                  );
                  await loadAdminGroups();
                }}
              >
                {group.status === 'active' ? 'Archive group' : 'Reopen group'}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="groups-section">
      {error && <div style={S.error}>{error}</div>}
      {notice && <div style={S.notice}>{notice}</div>}
      {inbox.can_administer && (
        <button
          type="button"
          style={{ ...S.secondary, width: '100%', marginBottom: 8 }}
          onClick={() => {
            setShowAdmin(true);
            loadAdminGroups();
          }}
        >
          Study admin controls
        </button>
      )}
      {!!inbox.announcements.length && (
        <>
          <div style={S.sectionTitle}>Updates from the study team</div>
          {inbox.announcements.map((announcement) => (
            <button
              key={announcement._id}
              type="button"
              style={{
                ...S.card,
                ...S.cardButton,
                ...(!announcement.read_at
                  ? { borderColor: '#93c5fd', background: '#eff6ff' }
                  : {}),
              }}
              onClick={() => markAnnouncementRead(announcement)}
            >
              <span style={S.icon}>◆</span>
              <span style={S.cardText}>
                <span style={S.title}>{announcement.title}</span>
                <span style={S.preview}>{announcement.content}</span>
              </span>
              {!announcement.read_at && <span style={S.badge}>1</span>}
            </button>
          ))}
        </>
      )}
      {!!inbox.invitations.length && (
        <>
          <div style={S.sectionTitle}>Group invitations</div>
          {inbox.invitations.map((invitation) => (
            <div key={invitation.invitation_id} style={S.card}>
              <span style={S.icon}>♟</span>
              <span style={S.cardText}>
                <span style={S.title}>{invitation.group_name}</span>
                <span style={{ ...S.preview, whiteSpace: 'normal' }}>
                  {invitation.group_description ||
                    'Invitation from the study team'}{' '}
                  · {invitation.member_count} members
                </span>
                <span
                  style={{
                    ...S.preview,
                    marginTop: 3,
                    whiteSpace: 'normal',
                    fontSize: 10.5,
                  }}
                >
                  Joining shares your participant ID and future group messages.
                </span>
                <span style={{ ...S.actions, marginTop: 7 }}>
                  <button
                    type="button"
                    style={S.primary}
                    onClick={() => respondInvitation(invitation, 'accept')}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    style={S.secondary}
                    onClick={() => respondInvitation(invitation, 'decline')}
                  >
                    Decline
                  </button>
                </span>
              </span>
            </div>
          ))}
        </>
      )}
      <div style={S.sectionTitle}>Groups</div>
      {!inbox.groups.length ? (
        <div style={{ ...S.preview, padding: '5px 2px 9px' }}>
          No groups joined yet.
        </div>
      ) : (
        inbox.groups.map((group) => (
          <button
            key={group.group_id}
            type="button"
            style={{ ...S.card, ...S.cardButton }}
            onClick={() => openGroup(group)}
          >
            <span style={S.icon}>♟</span>
            <span style={S.cardText}>
              <span style={S.title}>
                {group.name} {group.muted ? '· Muted' : ''}
              </span>
              <span style={S.preview}>
                {group.last_message?.content || `${group.member_count} members`}
              </span>
            </span>
            {group.unread_count > 0 && (
              <span style={S.badge}>{group.unread_count}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
