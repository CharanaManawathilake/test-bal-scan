import ballerina/crypto;
import ballerina/file;
import ballerina/http;
import ballerina/os;

// Each resource mirrors a noncompliant example from the library rule docs.
@http:ServiceConfig {
    cors: {
        allowOrigins: ["*"],
        allowMethods: ["*"]
    }
}
service /api on new http:Listener(9090) {
    @http:ResourceConfig {
        cors: {
            allowOrigins: ["*"]
        }
    }
    resource function get greeting() returns string {
        return "hello";
    }

    resource function 'default anything() returns string {
        return "any method";
    }

    resource function get cookie() returns http:Response {
        http:Response res = new;
        http:Cookie cookie = new ("session", "abc123", path = "/");
        res.addCookie(cookie);
        return res;
    }

    resource function delete files(string name) returns error? {
        check file:remove("/var/data/" + name);
    }

    resource function post tmp(string name) returns error? {
        check file:create("/tmp/" + name);
    }

    resource function post run(string command) returns error? {
        os:Process _ = check os:exec({value: command});
    }

    resource function post login(string password) returns string {
        byte[] hashed = crypto:hashMd5(password.toBytes());
        return hashed.toBase16();
    }
}
