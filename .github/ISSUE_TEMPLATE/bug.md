---
name: Bug report
description: Something in Harbor is not working
labels: [bug]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for testing the beta. Paste the diagnostics bundle first — it tells us the version,
        the machine, and what your apps are doing, without any secrets.
  - type: textarea
    id: diagnostics
    attributes:
      label: "`harbor diagnostics` output"
      description: Run `harbor diagnostics` on the machine and paste the whole block here.
      placeholder: |
        Harbor 0.17.0-beta.1 (...) on harbor — Ubuntu 24.04 ...
        Docker: available ...
        ...
      render: text
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Harbor version
      description: From `harbor doctor` or Settings → Overview.
      placeholder: 0.17.0-beta.1
    validations:
      required: true
  - type: dropdown
    id: install
    attributes:
      label: Install type
      options:
        - Fresh install from the one-line installer
        - Manual bootstrap from the release archive
        - Upgrade from an earlier release (say which below)
  - type: textarea
    id: steps
    attributes:
      label: What did you do, step by step?
      description: What you clicked or typed, what you expected, and what happened instead.
      placeholder: |
        1. ...
        2. ...
        Expected: ...
        Got: ...
    validations:
      required: true
  - type: textarea
    id: extra
    attributes:
      label: Anything else?
      description: Screenshots, app names, drive setup — anything that is not a secret. Never paste passphrases, recovery keys, passwords or tokens.
      render: text
---
