function getResult() returns int|error => 1;

public function main() {
    string password = "admin123";
    _ = checkpanic getResult();
    _ = password;
}
