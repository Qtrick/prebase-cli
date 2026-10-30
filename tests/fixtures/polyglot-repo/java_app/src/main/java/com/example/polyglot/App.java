package com.example.polyglot;

import java.util.List;
import com.example.polyglot.service.UserService;

public class App {
    public static void main(String[] args) {
        UserService svc = new UserService();
        System.out.println(svc.getRole());
    }
}

