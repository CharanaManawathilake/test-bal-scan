import ballerina/scan;

@scan:Suppress {rules: ["ballerina:13"], reason: "Test fixture token"}
const string SECRET_TOKEN = "tok_1234567890";

public function greet(string name, @scan:Suppress {reason: "Kept for API compatibility"} int unused) returns string {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Literal always parses"}
    int count = checkpanic int:fromString("1");
    return "Hello " + name + count.toString();
}
