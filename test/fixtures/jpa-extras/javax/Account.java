package extras.legacy;

import java.util.ArrayList;
import java.util.List;
import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.OneToMany;
import javax.persistence.Table;
import javax.validation.constraints.NotNull;

// The legacy javax.persistence package: JPA 2.x, Hibernate 5 and Spring Boot 2.
@Entity
@Table(name = "accounts")
public class Account {
  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @NotNull
  @Column(length = 120)
  private String owner;

  @OneToMany(mappedBy = "account")
  private List<Invoice> invoices = new ArrayList<>();
}
