package extras.unsupported;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.OneToOne;
import jakarta.persistence.PrimaryKeyJoinColumn;

// The older way to share a key: the id column of Wallet is read as the foreign key to Ledger, but Hibernate creates no constraint.
@Entity
public class Wallet {
  @Id private Long id;

  @OneToOne
  @PrimaryKeyJoinColumn
  private Ledger owner;

  private Integer balance;
}
