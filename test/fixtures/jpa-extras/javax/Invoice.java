package extras.legacy;

import java.math.BigDecimal;
import javax.persistence.*;

@Entity
public class Invoice {
  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(precision = 10, scale = 2, nullable = false)
  private BigDecimal total;

  @ManyToOne(optional = false, fetch = FetchType.LAZY)
  @JoinColumn(name = "account_id")
  private Account account;
}
