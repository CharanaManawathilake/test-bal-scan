// Triggers several core rules so the scan has something to report.
configurable string dbUser = "admin";

const string API_KEY = "sk_live_1234567890abcdef";

function getResult() returns int|error => 1;

function unusedParam(int used, int unused) returns int {
    return used;
}

public function main() {
    int result = checkpanic getResult();
    boolean always = result > int:MIN_VALUE || true;
    int x = 10;
    x = x;
    string password = "hunter2";
    foreach int i in 10 ..< 1 {
        result += i;
    }
    _ = unusedParam(result, x);
    _ = always;
    _ = password;
    _ = dbUser;
}
