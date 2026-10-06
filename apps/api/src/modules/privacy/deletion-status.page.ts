// Privacy (PrivacyModule, Gulf T7 / D7): the human-readable status page
// behind the URL we return to Meta's Data Deletion Request callback.
//
// Meta requires the URL to show "a human-readable explanation of the status
// of their request, including a legitimate justification for any refusal to
// delete". Server-rendered and dependency-free on purpose: it has to work for
// a Facebook user who has never seen our console and never will.
//
// Every interpolated value is escaped even though today they are all ours
// (an enum and two ISO timestamps) — the cost is nil and it keeps this safe
// if someone later adds a field that is not.
import type { DeletionRequestStatus } from './meta-data-deletion.service';

const EXPLANATIONS: Record<DeletionRequestStatus['status'], string> = {
  pending:
    'We have received your request and are deleting the data we hold that is linked to your Facebook account.',
  completed:
    'We have deleted the data linked to your Facebook account: the access tokens your Facebook login granted to this app, and the record of which pages or Instagram accounts you connected. The businesses whose pages you connected keep their own customer conversations; contact them directly to have those removed.',
  failed:
    'Deleting your data did not complete. Our team has been alerted and will finish it; you do not need to submit a new request. If this page still shows this message after a few days, contact us and quote the confirmation code below.',
};

export function renderDeletionStatusPage(
  status: DeletionRequestStatus,
): string {
  const completed = status.completedAt
    ? `<p>Completed: ${escapeHtml(status.completedAt.toISOString())}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Data deletion request status</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Data deletion request</h1>
<p>Status: <strong>${escapeHtml(status.status)}</strong></p>
<p>${escapeHtml(EXPLANATIONS[status.status])}</p>
<p>Confirmation code: <code>${escapeHtml(status.confirmationCode)}</code></p>
<p>Requested: ${escapeHtml(status.requestedAt.toISOString())}</p>
${completed}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
