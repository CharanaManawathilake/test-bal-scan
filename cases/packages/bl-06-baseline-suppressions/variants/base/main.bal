import ballerina/scan;

function getResult() returns int|error => 1;

function first() {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Always succeeds"}
    int value = checkpanic getResult();
    _ = value;
}

function second() {
    int value = checkpanic getResult();
    _ = value;
}

public function main() {
    string password = "admin123";
    _ = password;
    first();
    second();
}
