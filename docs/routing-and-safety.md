# Routing and safety

## Provider selection precedence

For a configured repository, choose exactly one provider in this order:

1. An explicit issue URL whose provider is configured for the repository.
2. An explicit provider-qualified reference such as `linear:ENG-123`,
   `github:#318`, or `jira:OPS-42`.
3. A configured identifier pattern that matches exactly one provider.
4. The repository's configured default provider.

Never infer a provider from issue wording. When selection is ambiguous, stop
and ask. An explicit provider can override the default only when that provider
is configured for the repository.

Normal searches use the default provider. Searching all configured providers
must be explicit and results retain provider-qualified identifiers.

## Missing repository configuration

Normal coding work may continue with issue integration marked unresolved.
Read-only issue work may use an explicit URL or fully specified conversational
context after disclosing that it is outside configured context.

Writes fail closed until the repository, provider profile, target, and expected
identity are configured. Point to the shipped configuration example, but never
modify global configuration without approval. Temporary conversational context
cannot bypass a configured repository boundary or authorize a write.

## Provider failures

Never redirect a failed write to another issue system. Report authentication,
authorization, rate-limit, network, and provider failures distinctly. An
explicit override may select another provider only when it is already
configured for the repository.

## Workflow state mappings

Commands use canonical intents:

```text
open
in_progress
done
canceled
```

Project configuration maps those intents to provider-native states or labels.
Version one requires an explicit mapping and fails closed when it is absent.
GitHub has no native `in_progress` state, so it requires an explicit label
mapping.

Creating an issue without a requested state uses the provider's normal default.

## Creation behavior

Provider entries may declare required fields, defaults, and named presets.
Presets that change labels, priority, workflow, or templates are explicit.
An agent may suggest a preset but cannot silently select one.

Markdown templates are host-local and reusable. Required creation fields are
validated before a preview is created.

## Cross-provider links

Use a native relationship within one provider when the adapter supports it.
Otherwise, link with a canonical issue URL in a provider comment. Writing a
backlink to a second issue is a separate mutation with its own preview. Never
merge or equate issues because their titles are similar.

## Audit policy

Every attempted issue mutation appends minimal metadata to a mode-`0600` JSONL
audit log: timestamp, package version, canonical repository, provider alias and
type, identity ID, issue identifier and ID, operation, and result. Read
operations are not logged. The active file rotates at 10 MiB and retains five
older files.

Never store credentials, descriptions, comments, attachments, or other issue
content in the audit log.

```sh
project-context audit list --limit 100
project-context audit purge --yes
```

## Preview claim and uncertain results

Prepared payloads are encrypted locally, expire after ten minutes, and are
purged before new previews are created. Apply atomically claims a token before
calling a provider. A second apply cannot claim the same token.

If an error occurs after claim, the result is `indeterminate`: the provider may
have accepted the request even though the client did not receive a success
response. Inspect the issue before preparing another change. Never replay an
indeterminate token.
