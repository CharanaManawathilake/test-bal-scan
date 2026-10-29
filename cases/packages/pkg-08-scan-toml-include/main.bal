function getResult() returns int|error => 1;

public function main() {
    // Non-compliant
    int result = checkpanic getResult();
}


// Triggers several core rules so the scan has something to report.
configurable string dbUser = "admin";

const string API_KEY = "sk_live_1234567890abcdef";

function getOtherResult() returns int|error => 1;

function otherUnusedParam(int used, int unused) returns int {
    return used;
}

function more() {
    int result = checkpanic getOtherResult();
    boolean always = result > int:MIN_VALUE || true;
    int x = 10;
    x = x;
    string password = "hunter2";
    foreach int i in 10 ..< 1 {
        result += i;
    }
    _ = otherUnusedParam(result, x);
    _ = always;
    _ = password;
    _ = dbUser;
}
