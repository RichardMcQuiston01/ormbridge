import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class AuditEntry extends Model<
  InferAttributes<AuditEntry>,
  InferCreationAttributes<AuditEntry>
> {
  declare id: CreationOptional<string>;
  declare action: string;
  declare level: CreationOptional<'info' | 'warn' | null>;
  declare loggedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof AuditEntry {
    AuditEntry.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        action: { type: DataTypes.STRING(255), allowNull: false },
        level: { type: DataTypes.ENUM('info', 'warn'), defaultValue: 'info' },
        loggedAt: { type: DataTypes.DATE, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'AuditEntry',
        tableName: 'audit_entry',
        timestamps: true,
        underscored: true,
      }
    );
    return AuditEntry;
  }
}
