function getResult() returns int|error => 1;

public function main() {
    string password = "admin123";
    _ = checkpanic getResult();
    string backupPassword = "letmein42";
    _ = password + backupPassword;
}
