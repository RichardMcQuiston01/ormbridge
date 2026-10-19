package extras.keys;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinColumns;
import jakarta.persistence.ManyToOne;
import jakarta.validation.constraints.NotNull;

@Entity
public class Shipment {
  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  // A foreign key made of two columns.
  @ManyToOne
  @JoinColumns({
    @JoinColumn(name = "line_order_id", referencedColumnName = "orderId"),
    @JoinColumn(name = "line_no", referencedColumnName = "lineNo")
  })
  private OrderLine line;

  // Bean Validation: @NotNull makes the join column NOT NULL, too.
  @NotNull
  @ManyToOne
  @JoinColumn(name = "sender_id")
  private Person sender;
}
