# SFTP server

Any machine you can reach over SSH: a NAS, a friend's server, a rented box. Make an SSH key without a
passphrase (`ssh-keygen -t ed25519 -N '' -f harbor-backup`), put `harbor-backup.pub` into
`~/.ssh/authorized_keys` of the account on the server, and paste the private key here. Leave **Server key**
empty to trust the key the server shows at the first test; Harbor pins it and refuses a different one
afterwards. The server only ever stores encrypted pieces.
