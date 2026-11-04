// The negative counterpart of core-rules/core_rules.bal: the same constructs written so that no core rule applies.
import ballerina/io;

configurable string password = ?;

function getResult() returns int|error => 1;

function usedParameters(int first, int second) returns int {
    return first + second;
}

public isolated function publicHelper() returns int {
    return 1;
}

public isolated class Counter {
    private int count = 0;

    public isolated function get() returns int {
        lock {
            return self.count;
        }
    }
}

public type Shape isolated object {
    public isolated function area() returns float;
};

public function main() returns error? {
    int result = check getResult();
    boolean inRange = result < 100;
    boolean either = inRange || result > 5;
    int x = 10;
    x = x + 1;
    foreach int i in 1 ..< 10 {
        x += i;
    }
    string clientSecret = password;
    Counter c = new;
    io:println(usedParameters(result, x), publicHelper(), c.get(), either, clientSecret);
}
