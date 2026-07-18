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

Before a session-only write, show the temporary repository, provider,
workspace/project target, and scope, then require explicit confirmation. This
fallback is available only when the whole repository is unconfigured. It cannot
bypass an existing repository boundary. Offer `project-context init`, but never
modify global configuration without approval.

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
Without a mapping, provider metadata may resolve an intent only when exactly one
native state belongs to the compatible semantic category. Otherwise stop and
show the available choices. GitHub has no native `in_progress` state, so it
requires an explicit label mapping.

Creating an issue without a requested state uses the provider's normal default.

## Creation behavior

Provider entries may declare required fields, defaults, and named presets.
Presets that change labels, priority, workflow, or templates are explicit.
An agent may suggest a preset but cannot silently select one.

Markdown templates are host-local and reusable. The resolver validates required
template sections and variables before preparing the create operation.

## Cross-provider links

Use native relationships within one provider when supported. Across providers,
use canonical issue URLs. Writing a backlink or comment to the second issue is
a separate mutation included in the same preview. Never merge or equate issues
because their titles are similar.

## Audit policy

Every attempted issue mutation appends minimal metadata to a user-only JSONL
audit log: timestamp, canonical repository, provider profile, target IDs, issue
identifier, operation, result, and whether routing came from configuration or
temporary context.

Never store credentials, descriptions, comments, attachments, or other issue
content in the audit log.
