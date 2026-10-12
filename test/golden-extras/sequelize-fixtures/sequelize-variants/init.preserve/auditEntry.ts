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
  declare id: CreationOptional<number>;
  declare action: string;
  declare level: CreationOptional<'info' | 'warn' | null>;
  declare logged_at: Date;

  static initModel(sequelize: Sequelize): typeof AuditEntry {
    AuditEntry.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        action: { type: DataTypes.STRING(255), allowNull: false },
        level: { type: DataTypes.ENUM('info', 'warn'), defaultValue: 'info' },
        logged_at: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'AuditEntry',
        tableName: 'AuditEntry',
        timestamps: false,
      }
    );
    return AuditEntry;
  }
}
