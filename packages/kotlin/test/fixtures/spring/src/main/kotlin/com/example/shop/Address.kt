package com.example.shop

import jakarta.persistence.Column
import jakarta.persistence.Embeddable

@Embeddable
data class Address(
    @Column(name = "street_line")
    var street: String? = null,
    var city: String? = null,
    @Column(length = 10)
    var zip: String? = null,
)
