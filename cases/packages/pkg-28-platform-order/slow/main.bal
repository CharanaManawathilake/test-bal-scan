// 1 HIGH (ballerina:13), 2 MEDIUM and 3 LOW (ballerina:1) issues, as upstream's bal-project-with-gate-issues
string defaultValue = "";

function getResult() returns int|error => 1;

public function main() {
    string password = "password";
    string secret = defaultValue;
    string passwd = defaultValue;
    int first = checkpanic getResult();
    int second = checkpanic getResult();
    int third = checkpanic getResult();
}
