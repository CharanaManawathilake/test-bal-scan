// One file that triggers every core rule (ballerina:1 to ballerina:14); the trailing comments name the rule.
import ballerina/io;

string password = "hunter2"; // ballerina:13

string defaultValue = "";

function getResult() returns int|error => 1;

function unusedParameter(int used, int unused) returns int { // ballerina:2
    return used;
}

public function publicHelper() returns int { // ballerina:3
    return 1;
}

public class Counter { // ballerina:5
    private int count = 0;
    private string unusedField = "x"; // ballerina:11

    public function get() returns int { // ballerina:4
        return self.count;
    }
}

public type Shape object { // ballerina:6
    public function area() returns float;
};

public function main() {
    int result = checkpanic getResult(); // ballerina:1
    boolean alwaysTrue = result <= int:MAX_VALUE; // ballerina:7
    boolean alwaysFalse = result > int:MAX_VALUE; // ballerina:8
    boolean sameValue = alwaysTrue || false; // ballerina:9
    int x = 10;
    x = x; // ballerina:10
    foreach int i in 10 ..< 1 { // ballerina:12
        x += i;
    }
    string clientSecret = "abc123"; // ballerina:13
    string secret = defaultValue; // ballerina:14
    Counter c = new;
    io:println(unusedParameter(result, x), publicHelper(), c.get(), alwaysFalse, sameValue, clientSecret, secret, password);
}
