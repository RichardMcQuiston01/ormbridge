package com.example.shop

import jakarta.persistence.CascadeType
import jakarta.persistence.Column
import jakarta.persistence.Embedded
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.OneToMany
import jakarta.persistence.Table

@Entity
@Table(name = "customer")
class Customer(
    @field:Column(nullable = false, length = 120)
    var name: String,

    @Column(unique = true)
    var email: String? = null,

    @Enumerated(EnumType.STRING)
    @Column(length = 16)
    var tier: Tier = Tier.BASIC,

    @Embedded
    var address: Address? = null,
) : BaseEntity() {

    @OneToMany(mappedBy = "customer", cascade = [CascadeType.ALL], orphanRemoval = true)
    var orders: MutableList<PurchaseOrder> = mutableListOf()

    @ElementCollection
    var nicknames: Set<String> = emptySet()

    var loyaltyPoints: Int = 0

    var active: Boolean = true

    @Transient
    var cached: String? = null

    companion object {
        const val MAX_NAME = 120
    }
}

enum class Tier { BASIC, GOLD }
