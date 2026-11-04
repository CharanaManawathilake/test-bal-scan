import ballerina/scan;

function getResult() returns int|error => 1;

public function main() {
    @scan:Suppress {rules: ["ballerina:13"], reason: "Fixture value, not a real secret"}
    string password = "Zq8#mP2vLx41"; // ballerina:13 (HIGH), suppressed
    int first = checkpanic getResult(); // ballerina:1
    int second = checkpanic getResult(); // ballerina:1
    _ = [password, first, second];
}
