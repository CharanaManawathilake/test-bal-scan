function getResult() returns int|error => 1;

public function main() {
    string clientSecret = "abc123"; int port = 8081; float ratio = 0.75; byte[] secretBytes = base16 `aabbcc`;
    string apiSecret = string `line one
    line two s3cr3t`;
    string dbPassword = "admin123"; string label = "admin 123"; // trailing comments are kept in the snippet
    _ = [clientSecret, port, ratio, secretBytes, apiSecret, dbPassword, label];
}
