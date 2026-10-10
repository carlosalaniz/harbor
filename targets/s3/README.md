# S3-compatible storage

Any service that speaks the S3 API: Backblaze B2, Cloudflare R2, Wasabi, Amazon S3, a MinIO or SeaweedFS of
your own. Create a bucket (or let Harbor create it at the first test) and an access key limited to that
bucket. **Endpoint** is the service's host name (`s3.us-west-002.backblazeb2.com`); `http://` works for a
server on your own network. Turn on the provider's **object lock** / versioning if it has one: then even a
compromised machine cannot delete the backups already there. The provider only ever stores encrypted pieces.
