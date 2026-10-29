const string SECRET_TOKEN = "tok_1234567890";

public function greet(string name, int unused) returns string {
    int count = checkpanic int:fromString("1");
    return "Hello " + name + count.toString();
}
