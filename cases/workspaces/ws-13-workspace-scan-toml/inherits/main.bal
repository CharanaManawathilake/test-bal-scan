// 1 HIGH (ballerina:13) and 2 LOW (ballerina:1) issues
function getResult() returns int|error => 1;

public function main() {
    string password = "password";
    int first = checkpanic getResult();
    int second = checkpanic getResult();
}
