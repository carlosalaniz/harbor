# Proton Drive (beta)

Your Proton Drive through rclone's Proton backend. **Beta:** Proton has no official API for this, so it can
stop working when Proton changes things; always pair it with another place. Type your email, password and
the current two-factor code; the code is only needed at the first test, rclone keeps the session (in a
root-only file on this machine) afterwards. Proton stores only encrypted pieces; Harbor encrypts before
anything leaves the machine.
