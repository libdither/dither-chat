/** Mail's screens, as one chunk loaded the first time mail is drawn in a chat or a mail list opens (lazy.tsx). */
export { MailSidebar } from './MailSidebar.tsx';
export { MailSearchGroup } from './MailSearch.tsx';
export { ComposerLayer } from './Composer.tsx';
export { MailKeepSection } from './MailKeep.tsx';
export { ChatMailBody, MailThreadActions, mailMessageItems, threadFiling } from './ChatMail.tsx';
export { sendFromChat } from '../../mail/chatsend.ts';
export { deleteDraft, dismissSend, sendNow, undoSend } from '../../mail/drafts.ts';
